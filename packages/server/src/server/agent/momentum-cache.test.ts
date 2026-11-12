import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentMomentumHistoryEntry } from "@getpaseo/protocol/messages";
import { MomentumCache, readMomentumHistory } from "./momentum-cache.js";

const DAY = 24 * 60 * 60 * 1_000;

function entry(
  agentId: string,
  generatedAt: Date,
  overrides: Partial<AgentMomentumHistoryEntry> = {},
): AgentMomentumHistoryEntry {
  return {
    agentId,
    workspaceId: "ws-1",
    title: `Agent ${agentId}`,
    focus: `focus ${agentId}`,
    next: `next ${agentId}`,
    state: "ready_to_continue",
    sourceUpdatedAt: generatedAt.toISOString(),
    generatedAt: generatedAt.toISOString(),
    ...overrides,
  };
}

describe("MomentumCache", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "momentum-cache-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("persists summaries per workspace, newest first, and keeps the newest copy per agent", async () => {
    const now = Date.now();
    const cache = new MomentumCache(home);
    await cache.record([
      entry("a", new Date(now - 2_000)),
      entry("b", new Date(now - 1_000)),
      entry("c", new Date(now), { workspaceId: "ws-2" }),
    ]);
    // An older copy (for example from a stale agent record at startup) must not overwrite a newer one.
    await cache.record([
      entry("a", new Date(now - 5_000), { focus: "stale" }),
      entry("a", new Date(now + 1_000), { focus: "fresh" }),
    ]);

    // A separate reader (a session) sees what the daemon wrote.
    const history = await readMomentumHistory(home, "ws-1");
    expect(history.map((item) => [item.agentId, item.focus])).toEqual([
      ["a", "fresh"],
      ["b", "focus b"],
    ]);
    expect(await readMomentumHistory(home, "missing")).toEqual([]);
  });

  it("keeps summaries of deleted agents until they age out, and never prunes live agents", async () => {
    const now = Date.now();
    const cache = new MomentumCache(home);
    await cache.record([
      entry("deleted-recent", new Date(now - DAY)),
      entry("deleted-old", new Date(now - 40 * DAY)),
      entry("live-old", new Date(now - 40 * DAY)),
    ]);
    await cache.record([], new Set(["live-old"]));
    expect((await readMomentumHistory(home, "ws-1")).map((item) => item.agentId).sort()).toEqual([
      "deleted-recent",
      "live-old",
    ]);
  });

  it("reads an empty history before anything is cached", async () => {
    expect(await readMomentumHistory(home, "ws-1")).toEqual([]);
  });
});
