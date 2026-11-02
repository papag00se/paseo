import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  AgentMomentumHistoryEntrySchema,
  type AgentMomentumHistoryEntry,
} from "@getpaseo/protocol/messages";

/** Entries older than this whose agent is gone are dropped. */
const ENDED_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_ENTRIES = 500;

const CACHE_FILE_SCHEMA = z.object({
  version: z.literal(1),
  entries: z.array(AgentMomentumHistoryEntrySchema),
});

const momentumCacheFile = (paseoHome: string) => path.join(paseoHome, "momentum", "cache.json");

async function readEntries(file: string): Promise<AgentMomentumHistoryEntry[]> {
  try {
    return CACHE_FILE_SCHEMA.parse(JSON.parse(await readFile(file, "utf8"))).entries;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/**
 * Reads a workspace's cached summaries, newest first. The daemon's MomentumCache is the only
 * writer and replaces the file atomically, so sessions read it directly.
 */
export async function readMomentumHistory(
  paseoHome: string,
  workspaceId: string,
): Promise<AgentMomentumHistoryEntry[]> {
  return (await readEntries(momentumCacheFile(paseoHome)))
    .filter((entry) => entry.workspaceId === workspaceId)
    .sort((left, right) => Date.parse(right.generatedAt) - Date.parse(left.generatedAt));
}

/**
 * Persisted Momentum summaries, kept apart from agent records so a session's last summary and
 * next step survive the agent being deleted (for example by a retention plugin).
 */
export class MomentumCache {
  private entries: Map<string, AgentMomentumHistoryEntry> | null = null;
  private loading: Promise<Map<string, AgentMomentumHistoryEntry>> | null = null;
  private writes: Promise<void> = Promise.resolve();
  private readonly file: string;

  constructor(paseoHome: string) {
    this.file = momentumCacheFile(paseoHome);
  }

  private async load(): Promise<Map<string, AgentMomentumHistoryEntry>> {
    if (this.entries) return this.entries;
    this.loading ??= readEntries(this.file).then((parsed) => {
      this.entries = new Map(parsed.map((entry) => [entry.agentId, entry]));
      return this.entries;
    });
    return this.loading;
  }

  /** Records summaries, keeping whichever copy of each agent's summary is newest. */
  async record(
    updates: readonly AgentMomentumHistoryEntry[],
    liveAgentIds?: ReadonlySet<string>,
  ): Promise<void> {
    const entries = await this.load();
    let changed = false;
    for (const update of updates) {
      const existing = entries.get(update.agentId);
      if (existing && Date.parse(existing.generatedAt) >= Date.parse(update.generatedAt)) continue;
      entries.set(update.agentId, update);
      changed = true;
    }
    if (liveAgentIds) changed = this.prune(entries, liveAgentIds) || changed;
    if (changed) await this.persist(entries);
  }

  private prune(
    entries: Map<string, AgentMomentumHistoryEntry>,
    liveAgentIds: ReadonlySet<string>,
  ): boolean {
    const before = entries.size;
    const cutoff = Date.now() - ENDED_RETENTION_MS;
    for (const [agentId, entry] of entries) {
      if (!liveAgentIds.has(agentId) && Date.parse(entry.generatedAt) < cutoff)
        entries.delete(agentId);
    }
    const overflow = [...entries.values()]
      .sort((left, right) => Date.parse(right.generatedAt) - Date.parse(left.generatedAt))
      .slice(MAX_ENTRIES);
    for (const entry of overflow) entries.delete(entry.agentId);
    return entries.size !== before;
  }

  private persist(entries: Map<string, AgentMomentumHistoryEntry>): Promise<void> {
    const body = JSON.stringify({ version: 1, entries: [...entries.values()] });
    const previous = this.writes;
    this.writes = (async () => {
      await previous.catch(() => undefined);
      await mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      await writeFile(temp, body);
      await rename(temp, this.file);
    })();
    return this.writes;
  }
}
