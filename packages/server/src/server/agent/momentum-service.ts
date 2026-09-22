import { existsSync } from "node:fs";
import type { Logger } from "pino";
import { z } from "zod";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import {
  generateStructuredAgentResponseWithFallback,
  type StructuredGenerationLogger,
} from "./agent-response-loop.js";
import { type AgentManager, type ManagedAgent } from "./agent-manager.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import type { AgentStorage } from "./agent-storage.js";
import {
  resolveStructuredGenerationProviders,
  type StructuredGenerationDaemonConfig,
} from "./structured-generation-providers.js";
import type { ProviderSnapshotManager } from "./provider-snapshot-manager.js";

const MOMENTUM_SCHEMA = z.object({
  focus: z.string().trim().min(1).max(220),
  next: z.string().trim().min(1).max(220),
  state: z.enum(["working", "waiting_on_you", "blocked", "ready_to_continue", "parked"]),
});

const MAX_CONTEXT_CHARS = 6_000;
const STARTUP_LIMIT = 25;
const RECENT_ACTIVITY_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_MOMENTUM_PROVIDERS = [
  { provider: "pi", model: "openai-codex/gpt-5.6-luna", thinkingOptionId: "low" },
  { provider: "pi", model: "anthropic/claude-haiku-4-5", thinkingOptionId: "low" },
];

export class MomentumService {
  private readonly queued = new Set<string>();
  private readonly running = new Set<string>();
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly deps: {
      agentManager: AgentManager;
      agentStorage: AgentStorage;
      providerSnapshotManager: Pick<ProviderSnapshotManager, "listProviders">;
      readDaemonConfig: () => StructuredGenerationDaemonConfig;
      logger: StructuredGenerationLogger & Logger;
    },
  ) {}

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
    const candidates = (await this.deps.agentStorage.list())
      .filter(
        (agent) =>
          !agent.archivedAt &&
          !agent.internal &&
          (agent.requiresAttention || Date.parse(agent.updatedAt) >= cutoff),
      )
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, STARTUP_LIMIT);
    for (const candidate of candidates) {
      try {
        await ensureAgentLoaded(candidate.id, {
          agentManager: this.deps.agentManager,
          agentStorage: this.deps.agentStorage,
          ...(existsSync(candidate.cwd) ? {} : { cwdOverride: process.env.HOME ?? process.cwd() }),
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
    if (!agent || agent.internal) return;
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
      this.deps.agentManager.setMomentum(agent.id, {
        ...summary,
        sourceUpdatedAt,
        generatedAt: new Date().toISOString(),
      });
    } catch (error) {
      this.deps.logger.warn({ err: error, agentId }, "Momentum summary generation failed");
    } finally {
      this.running.delete(agentId);
    }
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
