import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import type { AgentDeparture } from "./agent-manager.js";
import { MomentumCache } from "./momentum-cache.js";
import { limitWords, MomentumService } from "./momentum-service.js";
import { ProjectMomentumCache, readProjectMomentum } from "./project-momentum-cache.js";
import type { StoredAgentRecord } from "./agent-storage.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const home = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-momentum-"));
  roots.push(root);
  return root;
};

const words = (count: number) => Array.from({ length: count }, (_, index) => `w${index}`).join(" ");

test("limitWords keeps at most the given number of words", () => {
  expect(limitWords("one two three", 5)).toBe("one two three");
  expect(limitWords(words(60), 50).split(" ")).toHaveLength(50);
  expect(limitWords(`  spaced   out  `, 5)).toBe("spaced out");
});

test("a project summary persists, ignores an older write, and is readable without the cache", async () => {
  const paseoHome = await home();
  const entry = {
    projectId: "p1",
    latest: "Fixed the build",
    next: "Ship it",
    generatedAt: "2026-11-16T10:00:00.000Z",
    agentId: "a1",
    agentTitle: "Build",
    provider: "pi",
    model: "m",
  };
  const cache = new ProjectMomentumCache(paseoHome);
  await cache.set(entry);
  await cache.set({ ...entry, latest: "Stale", generatedAt: "2026-11-15T10:00:00.000Z" });
  expect((await new ProjectMomentumCache(paseoHome).get("p1"))?.latest).toBe("Fixed the build");
  expect((await readProjectMomentum(paseoHome, "p1"))?.next).toBe("Ship it");
  expect(await readProjectMomentum(paseoHome, "other")).toBeNull();
  expect(
    JSON.parse(await readFile(path.join(paseoHome, "momentum", "projects.json"), "utf8")).version,
  ).toBe(1);
});

function record(overrides: Partial<StoredAgentRecord> = {}): StoredAgentRecord {
  return {
    id: "agent-1",
    provider: "pi",
    cwd: "/definitely/missing",
    workspaceId: "w1",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-16T00:00:00.000Z",
    title: "Build the thing",
    labels: {},
    lastStatus: "idle",
    config: { model: "anthropic/claude-opus-5-5", thinkingOptionId: "high" },
    ...overrides,
  } as StoredAgentRecord;
}

function service(
  paseoHome: string,
  generated: Array<{ config: Record<string, unknown>; prompt: string }>,
  reply: { latest: string; next: string } = { latest: "Did work", next: "Do more" },
  options: { fail?: boolean } = {},
) {
  return new MomentumService({
    agentManager: {
      getProviderAvailability: async () => ({ available: true }),
    } as never,
    agentStorage: {} as never,
    providerSnapshotManager: { listProviders: async () => [] } as never,
    readDaemonConfig: () => ({}),
    logger: createTestLogger() as never,
    paseoHome,
    resolveProjectId: async (workspaceId) =>
      workspaceId === "unknown" ? null : `project-of-${workspaceId}`,
    runner: (async (input: { agentConfig: Record<string, unknown>; prompt: string }) => {
      generated.push({ config: input.agentConfig, prompt: input.prompt });
      if (options.fail) throw new Error("model unavailable");
      return reply;
    }) as never,
  });
}

const departure = (
  overrides: Partial<StoredAgentRecord> = {},
  transcript = [{ role: "user" as const, text: "go" }],
): AgentDeparture => ({
  record: record(overrides),
  reason: "archived",
  transcript,
});
const settle = (milliseconds = 50) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test("a leaving hand-started agent's project is summarized by that agent's own model and thinking, in at most 50 words", async () => {
  const paseoHome = await home();
  const generated: Array<{ config: Record<string, unknown>; prompt: string }> = [];
  const momentum = service(paseoHome, generated, { latest: words(80), next: "Do more" });
  momentum.onDeparting(
    departure({}, [
      { role: "user", text: "Fix the failing build" },
      { role: "assistant", text: "Build fixed, tests green" },
    ]),
  );
  await settle();
  expect(generated[0]?.config).toMatchObject({
    provider: "pi",
    model: "anthropic/claude-opus-5-5",
    thinkingOptionId: "high",
  });
  expect(generated[0]?.prompt).toContain("Fix the failing build");
  const stored = await momentum.getProjectMomentum("project-of-w1");
  expect(stored).toMatchObject({
    next: "Do more",
    agentId: "agent-1",
    agentTitle: "Build the thing",
    provider: "pi",
    model: "anthropic/claude-opus-5-5",
  });
  expect(stored?.latest.split(" ")).toHaveLength(50);
});

test.each([
  ["a delegated agent", { labels: { "paseo.parent-agent-id": "main" } }],
  ["an internal agent", { internal: true }],
  ["an agent without a workspace", { workspaceId: undefined }],
  ["an agent in an unknown workspace", { workspaceId: "unknown" }],
])("%s does not trigger a project summary", async (_name, overrides) => {
  const paseoHome = await home();
  const generated: unknown[] = [];
  service(paseoHome, generated as never).onDeparting(
    departure(overrides as Partial<StoredAgentRecord>),
  );
  await settle();
  expect(generated).toEqual([]);
});

test("departures from one project are summarized in order, each building on the previous summary", async () => {
  const paseoHome = await home();
  const generated: Array<{ config: Record<string, unknown>; prompt: string }> = [];
  const momentum = service(paseoHome, generated, { latest: "First status", next: "Next one" });
  momentum.onDeparting(departure({ id: "a" }));
  momentum.onDeparting(departure({ id: "b" }));
  await settle(150);
  expect(generated).toHaveLength(2);
  expect(generated[0]?.prompt).toContain("no earlier summary");
  expect(generated[1]?.prompt).toContain("First status");
});

test("a failed summary leaves the previous project summary untouched", async () => {
  const paseoHome = await home();
  const generated: Array<{ config: Record<string, unknown>; prompt: string }> = [];
  const failing = service(paseoHome, generated, undefined, { fail: true });
  await new ProjectMomentumCache(paseoHome).set({
    projectId: "project-of-w1",
    latest: "Keep me",
    next: "n",
    generatedAt: "2026-11-01T00:00:00.000Z",
    agentId: "a",
    agentTitle: null,
    provider: null,
    model: null,
  });
  failing.onDeparting(departure());
  await settle(100);
  expect(generated.length).toBeGreaterThan(0);
  expect((await readProjectMomentum(paseoHome, "project-of-w1"))?.latest).toBe("Keep me");
});

test("seeding gives each project its newest per-agent summary without overwriting an existing one", async () => {
  const paseoHome = await home();
  const entry = (agentId: string, workspaceId: string, focus: string, generatedAt: string) => ({
    agentId,
    workspaceId,
    title: agentId,
    focus,
    next: `next of ${agentId}`,
    state: "parked" as const,
    sourceUpdatedAt: generatedAt,
    generatedAt,
  });
  await new MomentumCache(paseoHome).record([
    entry("old", "w1", "Older focus", "2026-11-01T00:00:00.000Z"),
    entry("new", "w1", words(70), "2026-11-10T00:00:00.000Z"),
    entry("kept", "w2", "Cached focus", "2026-11-05T00:00:00.000Z"),
    entry("ghost", "unknown", "No project", "2026-11-05T00:00:00.000Z"),
  ]);
  await new ProjectMomentumCache(paseoHome).set({
    projectId: "project-of-w2",
    latest: "Already summarized",
    next: "x",
    generatedAt: "2026-11-12T00:00:00.000Z",
    agentId: "z",
    agentTitle: null,
    provider: "pi",
    model: null,
  });
  const momentum = service(paseoHome, []);
  await momentum.seedProjects();
  const seeded = await momentum.getProjectMomentum("project-of-w1");
  expect(seeded).toMatchObject({
    agentId: "new",
    next: "next of new",
    provider: null,
    model: null,
  });
  expect(seeded?.latest.split(" ")).toHaveLength(50);
  expect((await momentum.getProjectMomentum("project-of-w2"))?.latest).toBe("Already summarized");
  expect(await momentum.getProjectMomentum("project-of-unknown")).toBeNull();
});
