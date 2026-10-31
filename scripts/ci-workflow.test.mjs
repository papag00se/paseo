import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { matchesGlob, relative as relativePath } from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";

const repoRoot = new URL("../", import.meta.url);
const ciWorkflowPath = new URL(".github/workflows/ci.yml", repoRoot);
const dockerWorkflowPath = new URL(".github/workflows/docker.yml", repoRoot);
const nixWorkflowPath = new URL(".github/workflows/nix.yml", repoRoot);
const filtersPath = new URL(".github/ci-paths.yml", repoRoot);
const serverTsconfigPath = new URL("packages/server/tsconfig.server.json", repoRoot);
const desktopPackagePath = new URL("packages/desktop/package.json", repoRoot);

// Tests stay locally runnable; hosted checks retain build/quality promises only.
const qualityJobs = ["format", "lint", "typecheck"];

function loadFilters(path) {
  const filters = {};
  let currentFilter;

  for (const line of readFileSync(path, "utf8").split("\n")) {
    const filterMatch = /^([a-z_]+):\s*$/.exec(line);
    if (filterMatch) {
      currentFilter = filterMatch[1];
      filters[currentFilter] = [];
      continue;
    }
    const patternMatch = /^  - "([^"]+)"\s*$/.exec(line);
    if (currentFilter && patternMatch) filters[currentFilter].push(patternMatch[1]);
  }
  return filters;
}

function filesUnder(relativeDirectory, predicate) {
  const directory = new URL(`${relativeDirectory}/`, repoRoot);
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      [relativeDirectory, relativePath(directory.pathname, entry.parentPath), entry.name]
        .filter(Boolean)
        .join("/")
        .replaceAll("\\", "/"),
    )
    .filter(predicate)
    .sort();
}

test("quality checks keep stable names and real commands without test-job dependencies", () => {
  const workflow = parseYaml(readFileSync(ciWorkflowPath, "utf8"));
  assert.ok("merge_group" in workflow.on);
  for (const id of qualityJobs) {
    const job = workflow.jobs[id];
    assert.equal(job.name, id);
    assert.equal(job.needs, undefined);
    assert.ok(
      job.steps.some((step) =>
        step.run?.includes(`npm run ${id === "format" ? "format:check" : id}`),
      ),
    );
  }
  assert.ok(workflow.jobs.typecheck.steps.some((step) => step.run === "npm run build:server"));
});

test("change gating allows superseded workflow runs to cancel", () => {
  for (const workflowPath of [ciWorkflowPath, dockerWorkflowPath, nixWorkflowPath]) {
    const source = readFileSync(workflowPath, "utf8");
    assert.doesNotMatch(
      source,
      /\$\{\{\s*always\(\)/,
      "always() keeps jobs alive after concurrency cancellation; use !cancelled() for fail-open gating",
    );
  }
});

test("focused contracts remain available locally rather than as required Actions tests", () => {
  const scripts = JSON.parse(readFileSync(desktopPackagePath, "utf8")).scripts;
  for (const name of ["test", "test:e2e:renderer", "test:e2e:browser-tabs"]) {
    assert.ok(scripts[name], `local desktop command ${name}`);
  }
  const server = JSON.parse(
    readFileSync(new URL("packages/server/package.json", repoRoot), "utf8"),
  );
  assert.ok(server.scripts["test:hub-cli-contract"]);
  assert.ok(
    readFileSync(new URL("scripts/daemon-launch-contract.test.mjs", repoRoot), "utf8").length,
  );
});

// Inspect executable YAML fields, then follow npm scripts and their lifecycle
// hooks. Labels are deliberately irrelevant: renaming a test step cannot hide it.
function assertNoHostedTests(workflow, packages, seen = new Set()) {
  function command(source, owner = packages.get("root")) {
    assert.doesNotMatch(source, /\b(?:vitest|jest)\s+(?:run|--)/);
    assert.doesNotMatch(source, /\bplaywright\s+test\b|\bnode\s+[^\n;&]*--test\b/);
    assert.doesNotMatch(source, /\bnpm\s+(?:run\s+)?test(?=[:\s]|$)/);
    assert.doesNotMatch(source, /(?:^|\s)(?:[^\s]*\/)?e2e\/[^\s]+\.(?:m?js|sh)\b/);
    assert.doesNotMatch(source, /\.\/result\/bin\/paseo\s+daemon\s+run/);
    const workspace = /--workspace(?:=|\s+)([^\s]+)/.exec(source)?.[1];
    const selected = workspace ? packages.get(workspace) : owner;
    assert.ok(selected, `unknown workspace in ${source}`);
    for (const match of source.matchAll(/\bnpm\s+(?:--prefix\s+\.\.\/\.\.\s+)?run\s+([\w:-]+)/g)) {
      const scriptOwner = match[0].includes("--prefix") ? packages.get("root") : selected;
      for (const name of [`pre${match[1]}`, match[1], `post${match[1]}`]) {
        const body = scriptOwner.scripts?.[name];
        if (!body) continue;
        const key = `${scriptOwner.name}:${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        command(body, scriptOwner);
      }
    }
  }
  function visit(value) {
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (key === "run" && typeof item === "string") command(item);
      if (key === "env" && item) assert.notEqual(String(item.PASEO_DESKTOP_SMOKE), "1");
      visit(item);
    }
  }
  visit(workflow);
  // npm ci also runs workspace/root installation hooks, not just named builds.
  for (const pkg of new Set(packages.values())) {
    for (const name of ["preinstall", "install", "postinstall", "prepare"]) {
      if (pkg.scripts?.[name]) command(pkg.scripts[name], pkg);
    }
  }
}

function policyPackages() {
  const packages = new Map();
  for (const path of [
    "package.json",
    ...filesUnder("packages", (candidate) => /^packages\/[^/]+\/package\.json$/.test(candidate)),
  ]) {
    const pkg = JSON.parse(readFileSync(new URL(path, repoRoot), "utf8"));
    packages.set(path === "package.json" ? "root" : pkg.name, pkg);
  }
  return packages;
}

test("all executable workflow and composite fields follow the local-only test policy", () => {
  const packages = policyPackages();
  for (const path of filesUnder(".github", (candidate) => /\.(?:yaml|yml)$/.test(candidate))) {
    assertNoHostedTests(parseYaml(readFileSync(new URL(path, repoRoot), "utf8")), packages);
  }
});

test("hosted policy rejects renamed npm tests, lifecycle tests and packaging smoke opt-ins", () => {
  const packages = policyPackages();
  packages.get("root").scripts["verify:renamed"] = "node --test scripts/example.mjs";
  for (const run of [
    "npm run verify:renamed",
    "npx vitest run",
    "npm run test:e2e --workspace=@getpaseo/app",
  ]) {
    assert.throws(() => assertNoHostedTests({ jobs: { renamed: { steps: [{ run }] } } }, packages));
  }
  assert.throws(() =>
    assertNoHostedTests(
      {
        jobs: {
          release: { steps: [{ run: "npm run build:desktop", env: { PASEO_DESKTOP_SMOKE: "1" } }] },
        },
      },
      packages,
    ),
  );
  packages.get("root").scripts.postinstall = "npm run verify:renamed";
  assert.throws(() => assertNoHostedTests({ jobs: {} }, packages));
});

test("server builds exclude test utilities at every domain depth", () => {
  const tsconfig = JSON.parse(readFileSync(serverTsconfigPath, "utf8"));
  assert.ok(tsconfig.exclude.includes("src/server/**/test-utils/**"));
  assert.ok(!tsconfig.exclude.includes("src/server/test-utils/**"));
});

test("PR routing declares stable behavior ownership", () => {
  const filters = loadFilters(filtersPath);
  assert.deepEqual(filters, {
    routing: [".github/ci-paths.yml"],
    workspace: [
      ".mise.toml",
      ".tool-versions",
      "package.json",
      "package-lock.json",
      "patches/**",
      "scripts/**",
      "tsconfig.json",
      "tsconfig.base.json",
      "vitest.config.ts",
    ],
    ci: [".github/actions/**", ".github/workflows/ci.yml"],
    format: [
      ".agents/**/*.{cjs,css,html,js,json,jsonc,jsx,md,mjs,ts,tsx,yaml,yml}",
      ".github/**/*.{cjs,css,html,js,json,jsonc,jsx,md,mjs,ts,tsx,yaml,yml}",
      "**/*.{cjs,css,html,js,json,jsonc,jsx,md,mjs,ts,tsx,yaml,yml}",
      "packages/expo-two-way-audio/**",
    ],
    quality: ["**/*.{cjs,js,json,jsx,mjs,ts,tsx}", "packages/expo-two-way-audio/**"],
    hub: ["packages/cli/src/commands/hub/**", "packages/server/src/server/hub/**"],
    server: ["plugins/**", "packages/server/**", "packages/app/e2e/support/fixtures/recording.*"],
    desktop: [
      "packages/desktop/**",
      "packages/app/src/desktop/**",
      "packages/app/src/**/*.electron.{ts,tsx}",
      "packages/server/src/server/browser-tools/**",
      "packages/app/e2e/support/**",
      "packages/app/*config.{cjs,js,ts}",
      "packages/app/package.json",
    ],
    app: ["packages/app/**", "packages/expo-two-way-audio/**"],
    sdk: [
      "packages/plugin/**",
      "plugin-examples/**",
      "public-docs/plugins/**",
      "packages/client/**",
      "packages/highlight/**",
      "packages/protocol/**",
    ],
    browser: [
      "packages/server/src/server/agent/provider-snapshot-manager.ts",
      "packages/server/src/server/session/provider/provider-catalog-session.ts",
      "packages/client/src/compat/normalize-provider-models.ts",
      "packages/protocol/src/client-capabilities.ts",
      "packages/server/src/server/agent/provider-registry.ts",
      "packages/server/src/server/agent/agent-sdk-types.ts",
      "packages/server/src/server/agent/providers/codex-app-server-agent.ts",
      "packages/server/src/server/agent/providers/claude/agent.ts",
      "packages/server/src/server/agent/plugin-provider.ts",
      "packages/server/src/server/plugins/{index,plugin-process,plugin-process-protocol,runtime}.ts",
      "packages/server/src/executable-resolution/**",
      "packages/plugin/src/server/provider.ts",
      "packages/app/src/!(desktop)/**",
      "packages/app/e2e/browser/**",
      "packages/app/e2e/support/**",
      "packages/app/assets/**",
      "packages/app/public/**",
      "packages/app/index.ts",
      "packages/app/*config.{cjs,js,ts}",
      "packages/app/package.json",
    ],
    relay: ["packages/relay/**"],
    cli: ["packages/cli/**"],
  });
});

test("cross-package invariants live in the suite that owns them", () => {
  const cliTests = filesUnder("packages/cli", (path) => path.endsWith(".test.ts"));
  assert.ok(cliTests.length > 0);
  for (const path of cliTests) {
    assert.doesNotMatch(
      readFileSync(new URL(path, repoRoot), "utf8"),
      /server\/src\/server\/test-utils/,
      path,
    );
  }

  const protocolWireCompatibility = new URL(
    "packages/protocol/src/messages.wire-compat.test.ts",
    repoRoot,
  );
  assert.match(readFileSync(protocolWireCompatibility, "utf8"), /wire schema compatibility/);
});

test("browser and desktop tests have exclusive, directory-owned suites", () => {
  const filters = loadFilters(filtersPath);
  const browserSpecs = filesUnder("packages/app/e2e", (path) => path.endsWith(".spec.ts"));
  const desktopSpecs = filesUnder("packages/desktop/e2e", (path) => path.endsWith(".spec.ts"));

  assert.ok(browserSpecs.length > 0);
  assert.ok(desktopSpecs.length > 0);
  assert.ok(browserSpecs.every((path) => path.startsWith("packages/app/e2e/browser/")));
  assert.ok(desktopSpecs.every((path) => path.startsWith("packages/desktop/e2e/")));

  const desktopPackage = JSON.parse(readFileSync(desktopPackagePath, "utf8"));
  assert.match(desktopPackage.scripts.test, /--exclude ["']e2e\/\*\*["']/);

  for (const path of browserSpecs) {
    assert.doesNotMatch(
      readFileSync(new URL(path, repoRoot), "utf8"),
      /paseoDesktop|injectDesktopBridge/,
    );
  }
  for (const path of desktopSpecs) {
    assert.ok(path.startsWith("packages/desktop/e2e/"));
  }

  const routingSource = readFileSync(filtersPath, "utf8");
  assert.doesNotMatch(routingSource, /desktop_bridge|playwright_desktop|browser-\*|browser-\*\//);
  assert.deepEqual(filters.desktop, [
    "packages/desktop/**",
    "packages/app/src/desktop/**",
    "packages/app/src/**/*.electron.{ts,tsx}",
    "packages/server/src/server/browser-tools/**",
    "packages/app/e2e/support/**",
    "packages/app/*config.{cjs,js,ts}",
    "packages/app/package.json",
  ]);
  assert.deepEqual(filters.browser, [
    "packages/server/src/server/agent/provider-snapshot-manager.ts",
    "packages/server/src/server/session/provider/provider-catalog-session.ts",
    "packages/client/src/compat/normalize-provider-models.ts",
    "packages/protocol/src/client-capabilities.ts",
    "packages/server/src/server/agent/provider-registry.ts",
    "packages/server/src/server/agent/agent-sdk-types.ts",
    "packages/server/src/server/agent/providers/codex-app-server-agent.ts",
    "packages/server/src/server/agent/providers/claude/agent.ts",
    "packages/server/src/server/agent/plugin-provider.ts",
    "packages/server/src/server/plugins/{index,plugin-process,plugin-process-protocol,runtime}.ts",
    "packages/server/src/executable-resolution/**",
    "packages/plugin/src/server/provider.ts",
    "packages/app/src/!(desktop)/**",
    "packages/app/e2e/browser/**",
    "packages/app/e2e/support/**",
    "packages/app/assets/**",
    "packages/app/public/**",
    "packages/app/index.ts",
    "packages/app/*config.{cjs,js,ts}",
    "packages/app/package.json",
  ]);
});

test("desktop CI selects every Electron overlay without selecting ordinary browser source", () => {
  const filters = loadFilters(filtersPath);
  const selectsDesktop = (path) => filters.desktop.some((pattern) => matchesGlob(path, pattern));
  const electronModules = filesUnder("packages/app/src", (path) => /\.electron\.tsx?$/.test(path));

  // CLAUDE.md and Metro permit feature-local overlays, so desktop CI must not depend on one
  // overlay directory: a valid feature-local overlay once missed desktop CI that way.
  assert.ok(electronModules.length > 0);
  for (const path of electronModules) {
    assert.ok(
      selectsDesktop(path),
      `${path} must select desktop CI regardless of its feature directory`,
    );
  }

  for (const [path, expected] of [
    ["packages/app/src/notification-open/source.electron.ts", true],
    ["packages/app/src/desktop/browser/pane/element-selector.electron.ts", true],
    ["packages/desktop/e2e/open-in-editor.spec.ts", true],
    ["packages/app/src/file-panels/markdown-preview/index.tsx", false],
    ["packages/app/src/components/file-explorer-pane.tsx", false],
  ]) {
    assert.equal(selectsDesktop(path), expected, path);
  }

  for (const spec of filesUnder("packages/app/e2e/browser", (path) => path.endsWith(".spec.ts"))) {
    assert.equal(selectsDesktop(spec), false, `${spec} belongs to the browser suite`);
  }
});

test("packaging runs on main without allocating pull-request runners", () => {
  for (const workflowPath of [dockerWorkflowPath, nixWorkflowPath]) {
    const source = readFileSync(workflowPath, "utf8");
    const trigger = source.split("jobs:", 1)[0];
    assert.match(trigger, /push:\s*\n\s+branches: \[main\]/);
    assert.doesNotMatch(trigger, /pull_request/);
    assert.doesNotMatch(source, /dorny\/paths-filter/);
  }
});

test("desktop packaging builds main pushes and only the pull requests that touch packaging", () => {
  const source = readFileSync(new URL(".github/workflows/desktop-packages.yml", repoRoot), "utf8");
  const trigger = source.split("jobs:", 1)[0];
  assert.match(trigger, /push:\s*\n\s+branches: \[main\]/);
  assert.match(trigger, /pull_request:\s*\n\s+paths:/);
  assert.match(trigger, /- "packages\/desktop\/\*\*"/);
  assert.doesNotMatch(source, /dorny\/paths-filter/);
  for (const action of ["actions/checkout", "actions/setup-node"]) {
    assert.match(source, new RegExp(`${action}@[0-9a-f]{40} # v\\d+\\.\\d+\\.\\d+`));
  }
});
