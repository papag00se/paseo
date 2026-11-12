import type { Command } from "commander";
import { connectToDaemon } from "../../utils/client.js";
import { fetchAgentOrNotFound } from "../../utils/agent-directory.js";
import type { CommandOptions, OutputSchema, SingleResult } from "../../output/index.js";

interface AgentDetachResult {
  agentId: string;
  status: "detached";
}

const detachSchema: OutputSchema<AgentDetachResult> = {
  idField: "agentId",
  columns: [
    { header: "AGENT ID", field: "agentId" },
    { header: "STATUS", field: "status" },
  ],
};

export async function runDetachCommand(
  agentIdArg: string,
  options: CommandOptions,
  _command: Command,
): Promise<SingleResult<AgentDetachResult>> {
  const client = await connectToDaemon({ target: options.daemonTarget });

  try {
    const agentId = (await fetchAgentOrNotFound(client, agentIdArg)).id;
    await client.detachAgent(agentId);
    return { type: "single", data: { agentId, status: "detached" }, schema: detachSchema };
  } finally {
    await client.close().catch(() => undefined);
  }
}
