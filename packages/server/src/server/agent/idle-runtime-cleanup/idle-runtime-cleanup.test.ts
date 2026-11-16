import { expect, onTestFinished, test } from "vitest";
import { createIdleRuntimeCleanup, type RuntimeCleanupCandidate } from "./index.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
class Runtime {
  readonly identity = {};
  busy = false;
  closed = false;
  resumable = true;
  activity = 0;
  parentAgentId: string | undefined;
  probe: (() => Promise<boolean>) | undefined;
  admitClose: (() => Promise<void>) | undefined;
  finishClose: (() => Promise<void>) | undefined;
  constructor(readonly id = "agent") {}
  capture(): RuntimeCleanupCandidate {
    const activity = this.activity;
    return {
      identity: this.identity,
      agentId: this.id,
      parentAgentId: this.parentAgentId,
      provider: "test",
      sessionId: this.resumable ? this.id : null,
      lastActivityAt: activity,
      retention: () => {
        if (this.closed) return "closed";
        if (this.busy) return "agent lifecycle is running";
        return this.activity === activity ? null : "the agent was active again or replaced";
      },
      canStopRuntime: this.probe,
      closeIfEligible: async (eligible) => {
        await this.admitClose?.();
        if (!eligible()) return false;
        this.closed = true;
        await this.finishClose?.();
        return true;
      },
    };
  }
}
function spyLogger() {
  const lines: Array<{ level: string; fields: Record<string, unknown>; message: string }> = [];
  const record = (level: string) => (fields: Record<string, unknown>, message: string) => {
    lines.push({ level, fields, message });
  };
  return {
    lines,
    logger: { debug: record("debug"), info: record("info"), warn: record("warn") },
    retained: () => lines.filter((line) => line.message === "Idle runtime retained"),
  };
}
function scenario(enabled = true, idleMinutes?: number) {
  const spy = spyLogger();
  const runtime = new Runtime();
  const runtimes = [runtime];
  let time = 0;
  let protectedCaller = false;
  let tick!: () => void;
  const cleanup = createIdleRuntimeCleanup({
    enabled,
    idleMinutes,
    logger: spy.logger as never,
    now: () => time,
    runtimes: () => runtimes.filter((item) => !item.closed).map((item) => item.capture()),
    protection: () => (protectedCaller ? "caller is waiting" : null),
    schedule: (callback, interval) => {
      expect(interval).toBe(60_000);
      tick = callback;
      return () => {};
    },
  });
  onTestFinished(() => cleanup.close());
  return {
    runtime,
    runtimes,
    spy,
    cleanup,
    tick: () => tick(),
    protect: (value: boolean) => {
      protectedCaller = value;
    },
    sweep: (minutes: number) => {
      time = minutes * 60_000;
      return cleanup.sweep();
    },
  };
}

test("a runtime without a provider check is collected at exactly one hour", async () => {
  const s = scenario();
  expect((await s.sweep(59)).collected).toEqual([]);
  expect((await s.sweep(60)).collected).toEqual([
    { agentId: "agent", provider: "test", sessionId: "agent" },
  ]);
});

test("activity restarts the single one-hour idle period", async () => {
  const s = scenario();
  await s.sweep(59);
  s.runtime.activity = 59 * 60_000;
  expect((await s.sweep(118)).collected).toEqual([]);
  expect((await s.sweep(119)).collected).toHaveLength(1);
});

test.each(["foreground", "finish subscription"])(
  "a positive provider check cannot override %s",
  async (blocker) => {
    const s = scenario();
    let calls = 0;
    s.runtime.probe = async () => {
      calls++;
      return true;
    };
    if (blocker === "foreground") s.runtime.busy = true;
    else s.protect(true);
    expect((await s.sweep(61)).collected).toEqual([]);
    expect(calls).toBe(0);
    s.runtime.busy = false;
    s.protect(false);
    expect((await s.sweep(62)).collected).toEqual([]);
    expect((await s.sweep(121)).collected).toEqual([]);
    expect((await s.sweep(122)).collected).toHaveLength(1);
  },
);

test.each(["veto", "error"])(
  "a supported provider %s retains the runtime until a fresh idle hour passes",
  async (decision) => {
    const s = scenario();
    s.runtime.probe = async () => {
      if (decision === "error") throw new Error("Probe failed");
      return false;
    };
    const blocked = await s.sweep(61);
    expect(blocked.collected).toEqual([]);
    expect(blocked.failures).toHaveLength(decision === "error" ? 1 : 0);
    await s.sweep(119);
    s.runtime.probe = async () => true;
    expect((await s.sweep(120)).collected).toEqual([]);
    expect((await s.sweep(179)).collected).toEqual([]);
    expect((await s.sweep(180)).collected).toHaveLength(1);
  },
);

test("an idle managed descendant with provider-held work vetoes its parent", async () => {
  const s = scenario();
  const child = new Runtime("child");
  child.parentAgentId = s.runtime.id;
  child.probe = async () => false;
  s.runtimes.push(child);
  expect((await s.sweep(61)).collected).toEqual([]);
  child.probe = async () => true;
  expect((await s.sweep(62)).collected).toEqual([]);
  expect((await s.sweep(122)).collected).toHaveLength(2);
});

test("new caller protection during an async provider probe prevents stale collection", async () => {
  const s = scenario();
  const probe = deferred<boolean>();
  s.runtime.probe = () => probe.promise;
  const collecting = s.sweep(61);
  s.protect(true);
  probe.resolve(true);
  expect((await collecting).collected).toEqual([]);
  expect(s.runtime.closed).toBe(false);
  s.protect(false);
  expect((await s.sweep(62)).collected).toEqual([]);
  expect((await s.sweep(122)).collected).toHaveLength(1);
});

test("a supported provider timeout retains ownership even if it later returns true", async () => {
  const s = scenario();
  const probe = deferred<boolean>();
  s.runtime.probe = () => probe.promise;
  const result = await s.sweep(61);
  expect(result.collected).toEqual([]);
  expect(result.failures[0]?.error).toEqual(new Error("Runtime safety probe timed out for agent"));
  probe.resolve(true);
  expect((await s.sweep(62)).collected).toEqual([]);
  expect(s.runtime.closed).toBe(false);
}, 15_000);

test("the host opt-out disables explicit sweeps and scheduled ticks", async () => {
  const s = scenario(false);
  let calls = 0;
  s.runtime.probe = async () => {
    calls++;
    return true;
  };
  expect((await s.sweep(61)).collected).toEqual([]);
  s.tick();
  await s.cleanup.close();
  expect(calls).toBe(0);
  expect(s.runtime.closed).toBe(false);
});

test("a managed descendant without persistence still protects its parent while working", async () => {
  const s = scenario();
  const child = new Runtime("initializing-child");
  child.parentAgentId = s.runtime.id;
  child.resumable = false;
  child.busy = true;
  s.runtimes.push(child);
  expect((await s.sweep(61)).collected).toEqual([]);
  child.busy = false;
  expect((await s.sweep(62)).collected).toEqual([]);
  expect((await s.sweep(122)).collected).toEqual([
    { agentId: "agent", provider: "test", sessionId: "agent" },
  ]);
  expect(child.closed).toBe(false);
});

test("the live host switch retains eligible runtimes and re-enables with their existing idle clocks", async () => {
  const s = scenario();
  s.cleanup.setEnabled(false);
  expect((await s.sweep(61)).collected).toEqual([]);
  expect(s.runtime.closed).toBe(false);
  s.cleanup.setEnabled(true);
  s.tick();
  expect((await s.cleanup.sweep()).collected).toHaveLength(1);
});

test.each([false, true])(
  "disabling during a probe invalidates the sweep (re-enable: %s)",
  async (reEnable) => {
    const s = scenario();
    const probe = deferred<boolean>();
    s.runtime.probe = () => probe.promise;
    const collecting = s.sweep(61);
    s.cleanup.setEnabled(false);
    if (reEnable) s.cleanup.setEnabled(true);
    probe.resolve(true);
    expect((await collecting).collected).toEqual([]);
    expect(s.runtime.closed).toBe(false);
    s.cleanup.setEnabled(true);
    expect((await s.sweep(62)).collected).toHaveLength(1);
  },
);

test.each([false, true])(
  "disabling while waiting for lifecycle admission prevents closure (re-enable: %s)",
  async (reEnable) => {
    const s = scenario();
    const admitted = deferred<void>();
    const waiting = deferred<void>();
    s.runtime.admitClose = () => {
      waiting.resolve();
      return admitted.promise;
    };
    const collecting = s.sweep(61);
    await waiting.promise;
    s.cleanup.setEnabled(false);
    if (reEnable) s.cleanup.setEnabled(true);
    admitted.resolve();
    expect((await collecting).collected).toEqual([]);
    expect(s.runtime.closed).toBe(false);
    s.cleanup.setEnabled(true);
    expect((await s.sweep(62)).collected).toHaveLength(1);
  },
);

test.each(["veto", "error"])(
  "an invalidated provider %s does not reset the idle clock",
  async (outcome) => {
    const s = scenario();
    const probe = deferred<boolean>();
    s.runtime.probe = async () => {
      await probe.promise;
      if (outcome === "error") throw new Error("Old probe failed");
      return false;
    };
    const collecting = s.sweep(61);
    s.cleanup.setEnabled(false);
    s.cleanup.setEnabled(true);
    probe.resolve(false);
    expect(await collecting).toEqual({ collected: [], failures: [] });
    s.runtime.probe = async () => true;
    expect((await s.sweep(62)).collected).toHaveLength(1);
  },
);

test("disabling lets a started close finish but prevents the next closure in that sweep", async () => {
  const s = scenario();
  const sibling = new Runtime("sibling");
  s.runtimes.push(sibling);
  const closing = deferred<void>();
  const finished = deferred<void>();
  s.runtime.finishClose = () => {
    closing.resolve();
    return finished.promise;
  };
  const collecting = s.sweep(61);
  await closing.promise;
  expect(s.runtime.closed).toBe(true);
  s.cleanup.setEnabled(false);
  finished.resolve();
  expect((await collecting).collected).toEqual([
    { agentId: "agent", provider: "test", sessionId: "agent" },
  ]);
  expect(sibling.closed).toBe(false);
  s.cleanup.setEnabled(true);
  expect((await s.sweep(62)).collected).toEqual([
    { agentId: "sibling", provider: "test", sessionId: "sibling" },
  ]);
});

test("the idle period is configurable and a live change applies to the next sweep", async () => {
  const s = scenario(true, 5);
  expect((await s.sweep(4)).collected).toEqual([]);
  expect((await s.sweep(5)).collected).toHaveLength(1);
  const other = scenario(true);
  other.cleanup.setIdleMinutes(30);
  expect((await other.sweep(29)).collected).toEqual([]);
  other.cleanup.setIdleMinutes(10);
  expect((await other.sweep(30)).collected).toHaveLength(1);
});

test("a retained idle runtime is reported once per reason, with the check that blocked it", async () => {
  const s = scenario();
  s.runtime.busy = true;
  await s.sweep(30);
  expect(s.spy.retained()).toEqual([]);
  expect(s.cleanup.retained()).toEqual([]);
  await s.sweep(61);
  await s.sweep(62);
  expect(s.spy.retained()).toHaveLength(1);
  expect(s.spy.retained()[0]!.fields).toMatchObject({
    agentId: "agent",
    reason: "agent lifecycle is running",
    idleMinutes: 61,
  });
  expect(s.cleanup.retained()).toEqual([
    expect.objectContaining({ agentId: "agent", reason: "agent lifecycle is running" }),
  ]);
  s.runtime.busy = false;
  s.protect(true);
  await s.sweep(63);
  await s.sweep(64);
  expect(s.spy.retained().map((line) => line.fields["reason"])).toEqual([
    "agent lifecycle is running",
    "caller is waiting",
  ]);
  s.protect(false);
  await s.sweep(65);
  expect(s.cleanup.retained()).toEqual([]);
  expect(s.runtime.closed).toBe(false);
});

test.each([
  ["a provider veto", async () => false, "provider reports work in progress (agent)", 0],
  [
    "a failing provider probe",
    async () => {
      throw new Error("Probe failed");
    },
    "runtime safety check failed: Probe failed",
    1,
  ],
])("%s is reported as the retention reason", async (_name, probe, reason, failures) => {
  const s = scenario();
  s.runtime.probe = probe;
  const result = await s.sweep(61);
  expect(result.failures).toHaveLength(failures);
  expect(s.spy.retained().map((line) => line.fields["reason"])).toEqual([reason]);
});

test("a descendant's blocker is reported against its parent by the descendant's id", async () => {
  const s = scenario();
  const child = new Runtime("child");
  child.parentAgentId = s.runtime.id;
  child.busy = true;
  s.runtimes.push(child);
  await s.sweep(61);
  expect(s.cleanup.retained().map((entry) => [entry.agentId, entry.reason])).toEqual([
    ["agent", "descendant child: agent lifecycle is running"],
    ["child", "agent lifecycle is running"],
  ]);
});

test("disabling the sweep forgets retention reasons", async () => {
  const s = scenario();
  s.runtime.busy = true;
  await s.sweep(61);
  expect(s.cleanup.retained()).toHaveLength(1);
  s.cleanup.setEnabled(false);
  expect(s.cleanup.retained()).toEqual([]);
});

test("closeNow releases an agent that is not yet idle for a period, even with the sweep disabled", async () => {
  const s = scenario(false);
  await s.sweep(1);
  expect(await s.cleanup.closeNow("agent")).toEqual({ closed: true });
  expect(s.runtime.closed).toBe(true);
  expect(await s.cleanup.closeNow("agent")).toEqual({
    closed: false,
    reason: "the agent has no open runtime",
  });
});

test.each([
  [
    "working",
    (s: ReturnType<typeof scenario>) => (s.runtime.busy = true),
    "agent lifecycle is running",
  ],
  ["waited on", (s: ReturnType<typeof scenario>) => s.protect(true), "caller is waiting"],
  [
    "vetoed by the provider",
    (s: ReturnType<typeof scenario>) => (s.runtime.probe = async () => false),
    "provider reports work in progress (agent)",
  ],
  [
    "a descendant is working",
    (s: ReturnType<typeof scenario>) => {
      const child = new Runtime("child");
      child.parentAgentId = s.runtime.id;
      child.busy = true;
      s.runtimes.push(child);
    },
    "descendant child: agent lifecycle is running",
  ],
  [
    "without a saved session",
    (s: ReturnType<typeof scenario>) => (s.runtime.resumable = false),
    "the agent has no saved session to resume from",
  ],
])("closeNow refuses an agent that is %s", async (_name, arrange, reason) => {
  const s = scenario();
  arrange(s);
  expect(await s.cleanup.closeNow("agent")).toEqual({ closed: false, reason });
  expect(s.runtime.closed).toBe(false);
});
