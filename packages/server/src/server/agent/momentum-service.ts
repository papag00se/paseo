import { access } from "node:fs/promises";
import type { Logger } from "pino";
import { z } from "zod";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { isDelegatedAgent } from "@getpaseo/protocol/agent-labels";
import {
  generateStructuredAgentResponse,
  generateStructuredAgentResponseWithFallback,
  type StructuredGenerationLogger,
} from "./agent-response-loop.js";
import {
  type AgentDeparture,
  type AgentManager,
  type DepartureMessage,
  type ManagedAgent,
} from "./agent-manager.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import type { AgentStorage } from "./agent-storage.js";
import {
  resolveStructuredGenerationProviders,
  type StructuredGenerationDaemonConfig,
} from "./structured-generation-providers.js";
import type { ProviderSnapshotManager } from "./provider-snapshot-manager.js";
import { MomentumCache } from "./momentum-cache.js";
import { ProjectMomentumCache } from "./project-momentum-cache.js";
import type { ProjectMomentum } from "@getpaseo/protocol/messages";

const MOMENTUM_SCHEMA = z.object({
  focus: z.string().trim().min(1).max(220),
  next: z.string().trim().min(1).max(220),
  state: z.enum(["working", "waiting_on_you", "blocked", "ready_to_continue", "parked"]),
});

const MAX_CONTEXT_CHARS = 6_000;
/** The project summary is written by the departing agent's own model, so it can read more. */
const PROJECT_CONTEXT_CHARS = 24_000;
const PROJECT_CONTEXT_MESSAGES = 16;
const PROJECT_SUMMARY_WORDS = 50;
const PROJECT_SUMMARY_SCHEMA = z.object({
  latest: z.string().trim().min(1).max(600),
  next: z.string().trim().min(1).max(600),
});
const STARTUP_LIMIT = 25;
const RECENT_ACTIVITY_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_MOMENTUM_PROVIDERS = [
  { provider: "pi", model: "openai/gpt-6.1-terra", thinkingOptionId: "low" },
  { provider: "pi", model: "anthropic/claude-haiku-5-5", thinkingOptionId: "low" },
];

export class MomentumService {
  private readonly queued = new Set<string>();
  private readonly running = new Set<string>();
  private unsubscribe: (() => void) | null = null;
  private readonly cache: MomentumCache;
  private readonly projectCache: ProjectMomentumCache;
  private readonly projectQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly deps: {
      agentManager: AgentManager;
      agentStorage: AgentStorage;
      providerSnapshotManager: Pick<ProviderSnapshotManager, "listProviders">;
      readDaemonConfig: () => StructuredGenerationDaemonConfig;
      logger: StructuredGenerationLogger & Logger;
      paseoHome: string;
      /** The project a workspace belongs to; null when the workspace is unknown. */
      resolveProjectId?: (workspaceId: string) => Promise<string | null>;
      /** Test seam: replaces the call that runs one structured generation. */
      runner?: typeof generateStructuredAgentResponse;
    },
  ) {
    this.cache = new MomentumCache(deps.paseoHome);
    this.projectCache = new ProjectMomentumCache(deps.paseoHome);
  }

  /**
   * Summarizes a project when a hand-started agent in it is archived or deleted. The summary is
   * written by that agent's own provider and model, because a cheaper model can misread a long
   * session. Writes for one project run one at a time so each builds on the previous summary.
   */
  onDeparting(departure: AgentDeparture): void {
    const { record } = departure;
    if (record.internal || isDelegatedAgent(record) || !record.workspaceId) return;
    const workspaceId = record.workspaceId;
    void (async () => {
      const projectId = await this.deps.resolveProjectId?.(workspaceId);
      if (!projectId) return;
      const previous = this.projectQueues.get(projectId) ?? Promise.resolve();
      const next = previous
        .catch(() => undefined)
        .then(() => this.summarizeProject(projectId, departure));
      this.projectQueues.set(projectId, next);
      await next
        .catch((error) =>
          this.deps.logger.warn(
            { err: error, agentId: record.id, projectId },
            "Project Momentum summary failed",
          ),
        )
        .finally(() => {
          if (this.projectQueues.get(projectId) === next) this.projectQueues.delete(projectId);
        });
    })();
  }

  private async summarizeProject(projectId: string, departure: AgentDeparture): Promise<void> {
    const { record } = departure;
    const previous = await this.projectCache.get(projectId);
    const own = {
      provider: record.provider,
      model: record.runtimeInfo?.model ?? record.config?.model ?? undefined,
      thinkingOptionId: record.runtimeInfo?.thinkingOptionId ?? record.config?.thinkingOptionId,
    };
    const cwd = (await directoryExists(record.cwd))
      ? record.cwd
      : (process.env.HOME ?? process.cwd());
    // The agent's own model first; the usual Momentum models only if it cannot run.
    const configured = this.deps.readDaemonConfig();
    const fallbacks = await resolveStructuredGenerationProviders({
      cwd,
      providerSnapshotManager: this.deps.providerSnapshotManager,
      daemonConfig: configured.metadataGeneration?.providers?.length
        ? configured
        : { metadataGeneration: { providers: DEFAULT_MOMENTUM_PROVIDERS } },
      currentSelection: {
        provider: record.provider,
        model: own.model ?? null,
        thinkingOptionId: "low",
      },
    }).catch(() => []);
    const used: { provider: string; model: string | null } = {
      provider: own.provider,
      model: own.model ?? null,
    };
    const generate = this.deps.runner ?? generateStructuredAgentResponse;
    const summary = await generateStructuredAgentResponseWithFallback({
      manager: this.deps.agentManager,
      cwd,
      providers: [
        {
          provider: own.provider,
          ...(own.model ? { model: own.model } : {}),
          ...(own.thinkingOptionId ? { thinkingOptionId: own.thinkingOptionId } : {}),
        },
        ...fallbacks.filter(
          (candidate) => candidate.provider !== own.provider || candidate.model !== own.model,
        ),
      ],
      persistSession: false,
      maxRetries: 1,
      schema: PROJECT_SUMMARY_SCHEMA,
      schemaName: "ProjectMomentum",
      prompt: buildProjectPrompt(departure, previous),
      agentConfigOverrides: { title: "Project Momentum summary", internal: true },
      logger: this.deps.logger,
      // Record which candidate actually produced the summary.
      runner: async (options) => {
        const result = await generate(options);
        used.provider = options.agentConfig.provider;
        used.model = options.agentConfig.model ?? null;
        return result;
      },
    });
    await this.projectCache.set({
      projectId,
      latest: limitWords(summary.latest, PROJECT_SUMMARY_WORDS),
      next: limitWords(summary.next, PROJECT_SUMMARY_WORDS),
      generatedAt: new Date().toISOString(),
      agentId: record.id,
      agentTitle: record.title ?? null,
      provider: used.provider,
      model: used.model,
    });
  }

  /** The stored project summary, or null. */
  getProjectMomentum(projectId: string): Promise<ProjectMomentum | null> {
    return this.projectCache.get(projectId);
  }

  /**
   * Gives every project that has per-agent summaries but no project summary one, taken from its
   * newest agent summary. No model runs. Call once the workspace registry is loaded.
   */
  async seedProjects(): Promise<void> {
    const { resolveProjectId } = this.deps;
    if (!resolveProjectId) return;
    const newest = new Map<string, Awaited<ReturnType<MomentumCache["all"]>>[number]>();
    for (const entry of await this.cache.all()) {
      const projectId = await resolveProjectId(entry.workspaceId);
      if (!projectId) continue;
      const current = newest.get(projectId);
      if (!current || Date.parse(entry.generatedAt) > Date.parse(current.generatedAt)) {
        newest.set(projectId, entry);
      }
    }
    for (const [projectId, entry] of newest) {
      if (await this.projectCache.get(projectId)) continue;
      await this.projectCache.set({
        projectId,
        latest: limitWords(entry.focus, PROJECT_SUMMARY_WORDS),
        next: limitWords(entry.next, PROJECT_SUMMARY_WORDS),
        generatedAt: entry.generatedAt,
        agentId: entry.agentId,
        agentTitle: entry.title,
        provider: null,
        model: null,
      });
    }
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.deps.agentManager.subscribe(
      (event) => {
        if (event.type === "agent_stream" && event.event.type === "turn_completed") {
          this.schedule(event.agentId);
          return;
        }
        // Agents are restored lazily after daemon startup. Summarize them when
        // they resume or begin work, rather than waiting for a later completed turn.
        if (
          event.type === "agent_state" &&
          (event.agent.lifecycle === "idle" || event.agent.lifecycle === "running")
        ) {
          this.schedule(event.agent.id);
        }
      },
      { replayState: false },
    );

    // Agent runtimes are lazy. Backfill persisted records explicitly so every
    // recent workspace has a useful card immediately after daemon startup.
    void this.backfillStartupCandidates();
  }

  private async backfillStartupCandidates(): Promise<void> {
    const cutoff = Date.now() - RECENT_ACTIVITY_MS;
    const records = await this.deps.agentStorage.listAll();
    // Capture summaries already on agent records before anything deletes those agents.
    try {
      await this.cache.record(
        records.flatMap((record) =>
          record.momentum && record.workspaceId && !record.internal && !isDelegatedAgent(record)
            ? [
                {
                  ...record.momentum,
                  agentId: record.id,
                  workspaceId: record.workspaceId,
                  title: record.title ?? null,
                },
              ]
            : [],
        ),
        new Set(records.map((record) => record.id)),
      );
    } catch (error) {
      this.deps.logger.warn({ err: error }, "Momentum cache seeding failed");
    }
    const candidates = records
      .filter(
        (agent) =>
          !agent.archivedAt &&
          !agent.internal &&
          // Subagents summarize a parent's delegated step, not the workspace's own work.
          !isDelegatedAgent(agent) &&
          (agent.requiresAttention || Date.parse(agent.updatedAt) >= cutoff),
      )
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, STARTUP_LIMIT);
    for (const candidate of candidates) {
      try {
        await ensureAgentLoaded(candidate.id, {
          agentManager: this.deps.agentManager,
          agentStorage: this.deps.agentStorage,
          ...((await directoryExists(candidate.cwd))
            ? {}
            : { cwdOverride: process.env.HOME ?? process.cwd() }),
          logger: this.deps.logger,
        });
        await this.refresh(candidate.id);
      } catch (error) {
        this.deps.logger.warn(
          { err: error, agentId: candidate.id },
          "Momentum startup backfill failed",
        );
      }
    }
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  schedule(agentId: string): void {
    if (this.queued.has(agentId) || this.running.has(agentId)) return;
    this.queued.add(agentId);
    setTimeout(() => {
      this.queued.delete(agentId);
      void this.refresh(agentId);
    }, 750);
  }

  async refresh(agentId: string): Promise<void> {
    if (this.running.has(agentId)) return;
    const agent = this.deps.agentManager.getAgent(agentId);
    if (!agent || agent.internal || isDelegatedAgent(agent)) return;
    this.running.add(agentId);
    try {
      const sourceUpdatedAt = agent.updatedAt.toISOString();
      if (agent.momentum?.sourceUpdatedAt === sourceUpdatedAt) return;
      const configured = this.deps.readDaemonConfig();
      const providers = await resolveStructuredGenerationProviders({
        cwd: agent.cwd,
        providerSnapshotManager: this.deps.providerSnapshotManager,
        daemonConfig: configured.metadataGeneration?.providers?.length
          ? configured
          : { metadataGeneration: { providers: DEFAULT_MOMENTUM_PROVIDERS } },
        currentSelection: {
          provider: agent.provider,
          model: agent.runtimeInfo?.model ?? agent.config.model ?? null,
          thinkingOptionId: "low",
        },
      });
      const momentumProviders = providers.map((provider) => {
        const candidate: { provider: string; model?: string; thinkingOptionId: "low" } = {
          provider: provider.provider,
          thinkingOptionId: "low",
        };
        if (provider.model) candidate.model = provider.model;
        return candidate;
      });
      const summary = await generateStructuredAgentResponseWithFallback({
        manager: this.deps.agentManager,
        cwd: agent.cwd,
        providers: momentumProviders,
        persistSession: false,
        maxRetries: 1,
        schema: MOMENTUM_SCHEMA,
        schemaName: "Momentum",
        prompt: buildMomentumPrompt(agent, this.deps.agentManager.getTimeline(agent.id)),
        agentConfigOverrides: { title: "Momentum summary", internal: true },
        logger: this.deps.logger,
      });
      const momentum = { ...summary, sourceUpdatedAt, generatedAt: new Date().toISOString() };
      this.deps.agentManager.setMomentum(agent.id, momentum);
      if (agent.workspaceId) {
        await this.cache.record([
          {
            ...momentum,
            agentId: agent.id,
            workspaceId: agent.workspaceId,
            title: agent.config.title ?? null,
          },
        ]);
      }
    } catch (error) {
      this.deps.logger.warn({ err: error, agentId }, "Momentum summary generation failed");
    } finally {
      this.running.delete(agentId);
    }
  }
}

async function directoryExists(directory: string): Promise<boolean> {
  try {
    await access(directory);
    return true;
  } catch {
    return false;
  }
}

function buildMomentumPrompt(agent: ManagedAgent, timeline: readonly AgentTimelineItem[]): string {
  const context = timeline
    .filter((item) => item.type === "user_message" || item.type === "assistant_message")
    .slice(-6)
    .map((item) => `${item.type === "user_message" ? "User" : "Assistant"}: ${item.text}`)
    .join("\n\n")
    .slice(-MAX_CONTEXT_CHARS);
  let attention = "No deterministic attention state is pending.";
  if (agent.pendingPermissions.size > 0) {
    attention = "A real permission request is pending. State must be waiting_on_you.";
  } else if (agent.attention.requiresAttention) {
    attention = `Paseo attention reason: ${agent.attention.attentionReason}.`;
  }
  return `Summarize this coding-agent session for a desktop hover card. Be specific and concise. Do not invent work, blockers, or user requests. “next” is the most likely concrete next action, not generic advice.\n\nAgent title: ${agent.config.title ?? "(untitled)"}\nLifecycle: ${agent.lifecycle}\n${attention}\n\nRecent transcript:\n${context || "(No recent transcript available.)"}`;
}

/** Keeps the first `limit` words; the model is told the limit, this enforces it. */
export function limitWords(text: string, limit: number): string {
  const words = text.trim().split(/\s+/);
  return words.length <= limit ? words.join(" ") : `${words.slice(0, limit).join(" ")}…`;
}

function buildProjectPrompt(departure: AgentDeparture, previous: ProjectMomentum | null): string {
  const recent: DepartureMessage[] = departure.transcript.slice(-PROJECT_CONTEXT_MESSAGES);
  const transcript = recent
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.text}`)
    .join("\n\n")
    .slice(-PROJECT_CONTEXT_CHARS);
  const before = previous
    ? `Earlier project summary (written ${previous.generatedAt}):\nLatest: ${previous.latest}\nNext: ${previous.next}`
    : "There is no earlier summary for this project.";
  return `A coding-agent session in a project is ending (${departure.reason}). Write a short project status for a hover card shown when no agent is active.\n\n"latest": what was most recently done in this project, at most ${PROJECT_SUMMARY_WORDS} words. "next": the most likely concrete next steps, at most ${PROJECT_SUMMARY_WORDS} words. Be specific. Do not invent work, blockers or requests. Keep still-relevant facts from the earlier summary when this session does not replace them.\n\nEnding session title: ${departure.record.title ?? "(untitled)"}\n\n${before}\n\nRecent transcript of the ending session:\n${transcript || "(No transcript available.)"}`;
}
