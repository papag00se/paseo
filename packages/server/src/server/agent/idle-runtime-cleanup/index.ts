import type { Logger } from "pino";
import { withTimeout } from "../../../utils/promise-timeout.js";

/** A captured runtime capability. Its lifecycle owner revalidates before releasing it. */
export interface RuntimeCleanupCandidate {
  readonly identity: object;
  readonly agentId: string;
  readonly parentAgentId: string | undefined;
  readonly provider: string;
  readonly sessionId: string | null;
  readonly lastActivityAt: number;
  /** Why this runtime has pending work, or null when nothing blocks releasing it. */
  retention(): string | null;
  canStopRuntime?(): Promise<boolean>;
  closeIfEligible(revalidate: () => boolean): Promise<boolean>;
}
interface Options {
  enabled: boolean;
  runtimes(): readonly RuntimeCleanupCandidate[];
  /** Why a caller outside the agent manager still depends on this agent, or null. */
  protection?(agentId: string): string | null;
  /** Idle time before a runtime is released. Defaults to one hour. */
  idleMinutes?: number;
  logger: Pick<Logger, "debug" | "info" | "warn">;
  now?: () => number;
  schedule?: (tick: () => void, intervalMs: number) => () => void;
}
interface CollectionEntry {
  agentId: string;
  provider: string;
  sessionId: string;
}
interface CollectionResult {
  collected: CollectionEntry[];
  failures: Array<{ agentId: string; error: unknown }>;
}
export const DEFAULT_IDLE_MINUTES = 60;
const MINUTE_MS = 60_000;

/** An idle runtime the cleanup refuses to release, and why. */
export interface RetainedRuntime {
  agentId: string;
  provider: string;
  reason: string;
  /** Last agent activity, in epoch milliseconds. */
  lastActivityAt: number;
  /** When this reason was first observed, in epoch milliseconds. */
  since: number;
}

export type CloseNowResult = { closed: true } | { closed: false; reason: string };

/** Owns idle clocks, baseline eligibility, optional provider vetoes and the sweep lifetime. */
export function createIdleRuntimeCleanup(options: Options) {
  const protectedAt = new WeakMap<object, { at: number; protected: boolean }>();
  const retained = new Map<string, RetainedRuntime>();
  let collection: Promise<CollectionResult> | null = null;
  let stopped = false;
  let enabled = options.enabled;
  let idleMs = (options.idleMinutes ?? DEFAULT_IDLE_MINUTES) * MINUTE_MS;
  let generation = 0;
  const protection = options.protection ?? (() => null);
  const now = options.now ?? Date.now;

  function familyOf(root: RuntimeCleanupCandidate, runtimes: readonly RuntimeCleanupCandidate[]) {
    const family = new Map([[root.agentId, root]]);
    for (const parent of family.values()) {
      for (const child of runtimes) {
        if (child.parentAgentId === parent.agentId) family.set(child.agentId, child);
      }
    }
    return [...family.values()];
  }
  /** First baseline blocker in the family, naming the descendant when it is not the root. */
  function baselineRetention(
    root: RuntimeCleanupCandidate,
    family: readonly RuntimeCleanupCandidate[],
  ): string | null {
    for (const runtime of family) {
      const reason = runtime.retention() ?? protection(runtime.agentId);
      if (reason) return runtime === root ? reason : `descendant ${runtime.agentId}: ${reason}`;
    }
    return null;
  }
  async function providerRetention(
    family: readonly RuntimeCleanupCandidate[],
    isCurrent: () => boolean,
  ): Promise<string | null> {
    for (const runtime of family) {
      if (!isCurrent()) return "cleanup was disabled or stopped";
      if (!runtime.canStopRuntime) continue;
      const allowed = await withTimeout(
        runtime.canStopRuntime(),
        10_000,
        `Runtime safety probe timed out for ${runtime.agentId}`,
      );
      if (allowed !== true) return `provider reports work in progress (${runtime.agentId})`;
    }
    return null;
  }
  /** Idle for a whole period by activity alone, so a retention reason explains a missed collection. */
  function isDue(runtime: RuntimeCleanupCandidate, timestamp: number) {
    return timestamp - runtime.lastActivityAt >= idleMs;
  }
  /** Logs each retention reason once per agent, when the reason first appears or changes. */
  function noteRetention(runtime: RuntimeCleanupCandidate, reason: string, timestamp: number) {
    const previous = retained.get(runtime.agentId);
    if (previous?.reason === reason) return;
    retained.set(runtime.agentId, {
      agentId: runtime.agentId,
      provider: runtime.provider,
      reason,
      lastActivityAt: runtime.lastActivityAt,
      since: timestamp,
    });
    options.logger.info(
      {
        agentId: runtime.agentId,
        provider: runtime.provider,
        sessionId: runtime.sessionId,
        idleMinutes: Math.floor((timestamp - runtime.lastActivityAt) / MINUTE_MS),
        reason,
      },
      "Idle runtime retained",
    );
  }
  function clearRetention(agentId: string) {
    if (!retained.delete(agentId)) return;
    options.logger.debug({ agentId }, "Idle runtime no longer retained");
  }
  /** A blocked runtime restarts its idle clock; it is reported once it has been idle for a period. */
  function retain(runtime: RuntimeCleanupCandidate, reason: string, timestamp: number) {
    protectedAt.set(runtime.identity, { at: timestamp, protected: true });
    if (isDue(runtime, timestamp)) noteRetention(runtime, reason, timestamp);
    else clearRetention(runtime.agentId);
  }
  /** When the runtime's current unblocked idle stretch began. */
  function idleSince(runtime: RuntimeCleanupCandidate, timestamp: number) {
    if (protectedAt.get(runtime.identity)?.protected) {
      protectedAt.set(runtime.identity, { at: timestamp, protected: false });
    }
    return Math.max(runtime.lastActivityAt, protectedAt.get(runtime.identity)?.at ?? 0);
  }
  /** Releases the runtime when its whole family may be stopped and `revalidate` still holds. */
  async function release(
    runtime: RuntimeCleanupCandidate,
    family: readonly RuntimeCleanupCandidate[],
    isCurrent: () => boolean,
  ): Promise<boolean> {
    const revalidate = () => {
      const currentFamily = familyOf(runtime, options.runtimes());
      return (
        isCurrent() &&
        currentFamily.length === family.length &&
        currentFamily.every((current) =>
          family.some((captured) => captured.identity === current.identity),
        ) &&
        baselineRetention(runtime, family) === null
      );
    };
    if (!(await runtime.closeIfEligible(revalidate))) return false;
    retained.delete(runtime.agentId);
    options.logger.info(
      { agentId: runtime.agentId, provider: runtime.provider, sessionId: runtime.sessionId },
      "Collected idle agent runtime",
    );
    return true;
  }
  async function collect(): Promise<CollectionResult> {
    const result: CollectionResult = { collected: [], failures: [] };
    const sweepGeneration = generation;
    const isCurrent = () => enabled && !stopped && generation === sweepGeneration;
    if (!isCurrent()) return result;
    const timestamp = now();
    const runtimes = options.runtimes();
    for (const runtime of runtimes) {
      if (!isCurrent()) break;
      if (!runtime.sessionId) continue;
      const family = familyOf(runtime, runtimes);
      try {
        const reason =
          baselineRetention(runtime, family) ?? (await providerRetention(family, isCurrent));
        if (!isCurrent()) break;
        if (reason) {
          retain(runtime, reason, timestamp);
          continue;
        }
        clearRetention(runtime.agentId);
        if (timestamp - idleSince(runtime, timestamp) < idleMs) continue;
        if (await release(runtime, family, isCurrent)) {
          result.collected.push({
            agentId: runtime.agentId,
            provider: runtime.provider,
            sessionId: runtime.sessionId,
          });
        } else if (isCurrent()) {
          retain(runtime, "work started while the runtime was closing", timestamp);
        }
      } catch (error) {
        if (!isCurrent()) break;
        retain(runtime, `runtime safety check failed: ${errorMessage(error)}`, timestamp);
        result.failures.push({ agentId: runtime.agentId, error });
        options.logger.warn(
          { agentId: runtime.agentId, err: error },
          "Idle runtime cleanup failed",
        );
      }
    }
    const present = new Set(runtimes.map((runtime) => runtime.agentId));
    for (const agentId of retained.keys()) if (!present.has(agentId)) retained.delete(agentId);
    return result;
  }
  function sweep(): Promise<CollectionResult> {
    if (collection) return collection;
    collection = collect().finally(() => {
      collection = null;
    });
    return collection;
  }
  /**
   * Releases one agent's runtime now, ignoring the idle clock but applying every other check the
   * sweep applies. The agent stays resumable. Works while the periodic sweep is switched off.
   */
  async function closeNow(agentId: string): Promise<CloseNowResult> {
    if (stopped) return { closed: false, reason: "the daemon is shutting down" };
    const runtimes = options.runtimes();
    const runtime = runtimes.find((candidate) => candidate.agentId === agentId);
    if (!runtime) return { closed: false, reason: "the agent has no open runtime" };
    if (!runtime.sessionId) {
      return { closed: false, reason: "the agent has no saved session to resume from" };
    }
    const family = familyOf(runtime, runtimes);
    const isCurrent = () => !stopped;
    const reason =
      baselineRetention(runtime, family) ?? (await providerRetention(family, isCurrent));
    if (reason) return { closed: false, reason };
    if (await release(runtime, family, isCurrent)) return { closed: true };
    return { closed: false, reason: "work started while the runtime was closing" };
  }
  const schedule =
    options.schedule ??
    ((tick, intervalMs) => {
      const timer = setInterval(tick, intervalMs);
      timer.unref();
      return () => clearInterval(timer);
    });
  const cancel = schedule(() => {
    void sweep().catch((error) => options.logger.warn({ err: error }, "Idle runtime sweep failed"));
  }, MINUTE_MS);
  return {
    sweep,
    closeNow,
    /** Idle runtimes the last sweeps refused to release, with the reason for each. */
    retained: (): RetainedRuntime[] => [...retained.values()],
    setEnabled(value: boolean) {
      if (enabled === value) return;
      enabled = value;
      generation++;
      // Reasons describe sweeps that no longer run; the next enabled sweep rebuilds them.
      if (!value) retained.clear();
    },
    setIdleMinutes(minutes: number) {
      idleMs = minutes * MINUTE_MS;
    },
    async close() {
      stopped = true;
      cancel();
      await collection;
    },
  };
}

/** What sessions may ask of the cleanup: release one runtime on request, and list what is held back. */
export type IdleRuntimeControl = Pick<
  ReturnType<typeof createIdleRuntimeCleanup>,
  "closeNow" | "retained"
>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
