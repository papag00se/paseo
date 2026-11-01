import { beforeEach, describe, expect, it, vi } from "vitest";

import { runArchiveCommand } from "./archive.js";
import { runDetachCommand } from "./detach.js";
import { runReloadCommand } from "./reload.js";
import { runStopCommand } from "./stop.js";

const daemonTarget = { kind: "endpoint" as const, host: "example.test:12345" };
const agent = {
  id: "11111111-1111-4111-8111-111111111111",
  status: "running",
  archivedAt: null as string | null,
  cwd: "/tmp/project",
};

// Incident 2026-11-01: with ~19k stored agents, every `paseo agent archive <id>` paged the
// whole directory (~100 requests, each re-sorting every record), so parallel archives froze
// the daemon. Single-agent commands must let the daemon resolve the identifier.
const fetchAgents = vi.fn(async () => {
  throw new Error("single-agent commands must not page the agent directory");
});
const fetchAgent = vi.fn(async ({ agentId }: { agentId: string }) =>
  agent.id.startsWith(agentId) ? { agent } : null,
);
const client = {
  fetchAgents,
  fetchAgent,
  archiveAgent: vi.fn(async () => ({ archivedAt: "2026-11-01T00:00:00.000Z" })),
  refreshAgent: vi.fn(async (agentId: string) => ({ agentId, timelineSize: 3 })),
  detachAgent: vi.fn(async () => undefined),
  cancelAgent: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
};

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(async () => client),
}));

const commands = [
  ["archive", () => runArchiveCommand("1111", { daemonTarget, force: true }, {} as never)],
  ["reload", () => runReloadCommand("1111", { daemonTarget }, {} as never)],
  ["detach", () => runDetachCommand("1111", { daemonTarget }, {} as never)],
  ["stop", () => runStopCommand("1111", { daemonTarget }, {} as never)],
] as const;

describe("single-agent commands", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(commands)("%s resolves the agent with one daemon lookup", async (_name, run) => {
    await run();
    expect(fetchAgent).toHaveBeenCalledTimes(1);
    expect(fetchAgent).toHaveBeenCalledWith({ agentId: "1111" });
    expect(fetchAgents).not.toHaveBeenCalled();
  });

  it("reports an unknown agent as not found", async () => {
    await expect(runArchiveCommand("ffff", { daemonTarget }, {} as never)).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
    });
  });
});
