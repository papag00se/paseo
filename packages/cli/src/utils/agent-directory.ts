import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import type { connectToDaemon } from "./client.js";
import type { CommandError } from "../output/index.js";

type FetchAgentsOptions = NonNullable<
  Parameters<Awaited<ReturnType<typeof connectToDaemon>>["fetchAgents"]>[0]
>;

interface AgentDirectoryClient {
  fetchAgents(options?: FetchAgentsOptions): Promise<{
    entries: { agent: AgentSnapshotPayload }[];
    pageInfo: { nextCursor: string | null };
  }>;
}

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

interface AgentLookupClient {
  fetchAgent(options: { agentId: string }): Promise<{ agent: AgentSnapshotPayload } | null>;
}

/**
 * Resolve one agent by ID, unique ID prefix or exact title. The daemon resolves the
 * identifier against its own records, so this never pages the whole directory.
 */
export async function fetchAgentOrNotFound(
  client: AgentLookupClient,
  idOrName: string,
): Promise<AgentSnapshotPayload> {
  const result = await client.fetchAgent({ agentId: idOrName });
  if (!result) {
    const error: CommandError = {
      code: "AGENT_NOT_FOUND",
      message: `Agent not found: ${idOrName}`,
      details: 'Use "paseo ls" to list available agents',
    };
    throw error;
  }
  return result.agent;
}
