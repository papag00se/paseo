import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import type { CommandError } from "../output/index.js";
import { resolveAgentId, type connectToDaemon } from "./client.js";

type DaemonClient = Awaited<ReturnType<typeof connectToDaemon>>;
type FetchAgentsOptions = NonNullable<Parameters<DaemonClient["fetchAgents"]>[0]>;

export interface AgentDirectoryClient {
  fetchAgents(options?: FetchAgentsOptions): Promise<{
    entries: { agent: AgentSnapshotPayload }[];
    pageInfo: { nextCursor: string | null };
  }>;
}

export interface AgentLookupClient extends AgentDirectoryClient {
  fetchAgent(options: { agentId: string }): Promise<{
    agent: AgentSnapshotPayload;
  } | null>;
}

const FULL_AGENT_UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** Read the complete directory without agents moving between pages as they update. */
export async function fetchAllAgents(
  client: AgentDirectoryClient,
  options: Omit<FetchAgentsOptions, "page" | "sort" | "subscribe"> = {},
): Promise<AgentSnapshotPayload[]> {
  const agents: AgentSnapshotPayload[] = [];
  let cursor: string | undefined;
  // createdAt never changes, so agents cannot move past the cursor while the pages are read.
  do {
    const payload = await client.fetchAgents({
      ...options,
      sort: [{ key: "created_at", direction: "desc" }],
      page: { limit: 200, ...(cursor ? { cursor } : {}) },
    });
    agents.push(...payload.entries.map((entry) => entry.agent));
    cursor = payload.pageInfo.nextCursor ?? undefined;
  } while (cursor);
  return agents;
}

/**
 * Resolve an agent by ID, prefix, or name.
 *
 * Fork change: ask the daemon first. `fetch_agent` resolves an ID, unique prefix or exact title
 * against the daemon's own records in one request. Paging the whole directory first made every
 * archive, reload or detach read every stored agent, which froze a daemon holding ~19,000 of them.
 * Only when the daemon finds nothing is the directory read, for the partial-title matching it
 * cannot do and for agents it omits.
 */
export async function resolveAgentEntry(
  client: AgentLookupClient,
  agentIdArg: string,
): Promise<AgentSnapshotPayload | null> {
  const trimmed = agentIdArg.trim();
  if (!trimmed) {
    return null;
  }

  const fetchResult = await client.fetchAgent({ agentId: trimmed });
  if (fetchResult) {
    // COMPAT(fullAgentIdExact): daemons before v0.16.0 resolve a full agent ID that matches no
    // agent to an agent titled with it, so accept their answer only when it is that ID.
    if (!FULL_AGENT_UUID_PATTERN.test(trimmed) || fetchResult.agent.id === trimmed.toLowerCase()) {
      return fetchResult.agent;
    }
    return null;
  }
  if (FULL_AGENT_UUID_PATTERN.test(trimmed)) {
    return null;
  }

  const agents = await fetchAllAgents(client, { filter: { includeArchived: true } });
  const listedId = resolveAgentId(agentIdArg, agents);
  return listedId ? (agents.find((entry) => entry.id === listedId) ?? null) : null;
}

/** Resolve one agent through the daemon in a single request, or fail with AGENT_NOT_FOUND. */
export async function fetchAgentOrNotFound(
  client: AgentLookupClient,
  idOrName: string,
): Promise<AgentSnapshotPayload> {
  const agent = await resolveAgentEntry(client, idOrName);
  if (!agent) {
    const error: CommandError = {
      code: "AGENT_NOT_FOUND",
      message: `Agent not found: ${idOrName}`,
      details: 'Use "paseo ls" to list available agents',
    };
    throw error;
  }
  return agent;
}
