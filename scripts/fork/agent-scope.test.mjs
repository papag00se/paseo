// Runs against the real systemd user manager: the guarantees are about cgroups and the kernel, so a mock proves nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const scope = fileURLToPath(new URL("./agent-scope.sh", import.meta.url));
const run = (script, env = {}) =>
  spawnSync(scope, ["bash", "-c", script], { encoding: "utf8", env: { ...process.env, ...env } });

test("an agent gets its own scope with memory caps, a CPU window Node sizes worker pools to, and a TMPDIR on disk", () => {
  const out = run(
    'cg=/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup); echo "$cg"; cat $cg/memory.high $cg/memory.max $cg/memory.swap.max; ' +
      'echo "$TMPDIR"; node -e "console.log(require(\'os\').availableParallelism())"',
    { PASEO_AGENT_CPUS: "3", PASEO_AGENT_MEMORY_HIGH: "300M", PASEO_AGENT_MEMORY_MAX: "400M", PASEO_AGENT_SWAP_MAX: "0" },
  );
  assert.equal(out.status, 0, out.stderr);
  const [cgroup, high, max, swap, tmp, parallelism] = out.stdout.trim().split("\n");
  assert.match(cgroup, /\/app\.slice\/app-paseoagents\.slice\/paseo-agent-\d+-\d+\.scope$/);
  assert.deepEqual([high, max, swap], [String(300 * 2 ** 20), String(400 * 2 ** 20), "0"]);
  assert.match(tmp, /^\/var\/tmp\/paseo-agents\/paseo-agent-/);
  assert.ok(existsSync(tmp));
  assert.equal(parallelism, "3");
});

test("a child over the memory cap is killed inside the agent's scope and the agent keeps running", () => {
  const out = run(
    "python3 -c 'b = bytearray(700 * 2**20); b[::4096] = b\"x\" * len(b[::4096])'; echo \"child=$?\"; echo agent-alive",
    { PASEO_AGENT_MEMORY_HIGH: "infinity", PASEO_AGENT_MEMORY_MAX: "300M", PASEO_AGENT_SWAP_MAX: "0" },
  );
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /child=137\nagent-alive/); // 137 = SIGKILL from the cgroup OOM killer
});

test("concurrent agents rotate CPU windows instead of piling onto the same cores", () => {
  const windows = [0, 1].map(() => run("taskset -cp $$ | sed 's/.*: //'", { PASEO_AGENT_CPUS: "4" }).stdout.trim());
  assert.notEqual(windows[0], windows[1]);
});

test("the Claude shim runs the real claude through the scope", () => {
  const shim = fileURLToPath(new URL("./agent-scope-claude.sh", import.meta.url));
  const version = execFileSync(shim, ["--version"], { encoding: "utf8" });
  assert.match(version, /\d+\.\d+/);
});
