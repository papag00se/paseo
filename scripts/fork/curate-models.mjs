#!/usr/bin/env node
// Discover unfiltered catalogs in independent clients, never from the curated daemon list.
import { execFileSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  renameSync,
  chmodSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function modelClass(id, provider) {
  const base = id.replace(/\[1m\]$/, "").replace(/-\d{8}$/, "");
  const match =
    provider === "claude"
      ? /^claude-([a-z]+)-(\d+(?:-\d+)*)$/.exec(base)
      : /^gpt-(\d+(?:\.\d+)*)(?:-([a-z][a-z0-9-]*))?$/.exec(base);
  if (!match) return null;
  const family = provider === "claude" ? match[1] : (match[2] ?? "base");
  const version = (provider === "claude" ? match[2] : match[1]).split(/[.-]/).map(Number);
  return { family, version, canonical: id === base };
}

function compareVersions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

export function latestModels(models, provider, defaultFamily) {
  const families = new Map();
  for (const model of models) {
    const key = modelClass(model.id, provider);
    if (!key) continue;
    const old = families.get(key.family);
    const difference = old ? compareVersions(key.version, old.key.version) : 1;
    if (difference > 0 || (difference === 0 && key.canonical && !old.key.canonical)) {
      families.set(key.family, { key, model });
    }
  }
  const preferred = families.get(defaultFamily)?.model;
  if (!preferred)
    throw new Error(
      `${provider}: no ${defaultFamily} model; review the workhorse family before changing defaults`,
    );
  return [...families.values()].map(({ model }) =>
    Object.assign({}, model, { isDefault: model.id === preferred.id }),
  );
}

function profileModel(model, defaultId) {
  const result = { id: model.id, label: model.label, isDefault: model.id === defaultId };
  if (model.description) result.description = model.description;
  if (model.thinkingOptions) result.thinkingOptions = model.thinkingOptions;
  return result;
}

export function curateCatalogs(catalogs) {
  // Pi refreshes Anthropic's catalog independently of Paseo releases. Include
  // newly published IDs even before the native Claude manifest knows them.
  // Do not copy Pi's effort names into Claude: those are different APIs.
  const knownClaude = new Set(catalogs.claude.models.map((m) => m.id));
  const discoveredClaude = catalogs.pi.models
    .filter(
      (m) => m.id.startsWith("anthropic/") && !knownClaude.has(m.id.slice("anthropic/".length)),
    )
    .map((m) => ({
      id: m.id.slice("anthropic/".length),
      label: m.label.replace(/^anthropic\//, ""),
    }));
  const claude = latestModels([...catalogs.claude.models, ...discoveredClaude], "claude", "opus");
  const codex = latestModels(catalogs.codex.models, "codex", "sol");
  const claudeDefault = claude.find((m) => m.isDefault).id;
  const codexDefault = codex.find((m) => m.isDefault).id;
  const wanted = new Set([
    ...claude.map((m) => `anthropic/${m.id}`),
    ...codex.map((m) => `openai-codex/${m.id}`),
  ]);
  // Do not alter local/router providers. Only Anthropic and Codex are in this policy.
  const pi = catalogs.pi.models.filter(
    (m) => !/^(anthropic|openai-codex)\//.test(m.id) || wanted.has(m.id),
  );
  const piDefault = `anthropic/${claudeDefault}`;
  if (!pi.some((m) => m.id === piDefault))
    throw new Error(`Pi cannot use ${piDefault}; no configuration changed`);
  const defaults = { claude: claudeDefault, codex: codexDefault, pi: piDefault };
  return Object.fromEntries(
    Object.entries({ claude, codex, pi }).map(([id, models]) => [
      id,
      models.map((m) => profileModel(m, defaults[id])),
    ]),
  );
}

export function updatedSettings(config, piSettings, models) {
  const nextConfig = structuredClone(config);
  nextConfig.agents ??= {};
  nextConfig.agents.providers ??= {};
  for (const id of ["claude", "codex", "pi"]) {
    const provider = (nextConfig.agents.providers[id] ??= {});
    provider.models = models[id];
    // Old additions would reintroduce retired entries or a second default.
    delete provider.additionalModels;
  }
  const piDefault = models.pi.find((m) => m.isDefault).id;
  const slash = piDefault.indexOf("/");
  return {
    config: nextConfig,
    piSettings: {
      ...piSettings,
      defaultProvider: piDefault.slice(0, slash),
      defaultModel: piDefault.slice(slash + 1),
    },
  };
}

export async function discoverCatalogs(config) {
  const [{ buildProviderRegistry }, { default: pino }] = await Promise.all([
    import("../../packages/server/dist/server/server/agent/provider-registry.js"),
    import("pino"),
  ]);
  const overrides = structuredClone(config.agents?.providers ?? {});
  for (const id of ["claude", "codex", "pi"]) {
    overrides[id] ??= {};
    delete overrides[id].models;
    delete overrides[id].additionalModels;
  }
  const logger = pino({ level: "silent" });
  const registry = buildProviderRegistry(logger, { providerOverrides: overrides });
  const catalogs = {};
  for (const id of ["claude", "codex", "pi"]) {
    const client = registry[id].createClient(logger);
    try {
      catalogs[id] = await client.fetchCatalog({ scope: "global", cwd: homedir() });
    } finally {
      await client.shutdown?.();
    }
  }
  return catalogs;
}

function replaceJson(path, value, original) {
  if (readFileSync(path, "utf8") !== original)
    throw new Error(`${path} changed during discovery; refusing to overwrite`);
  const tmp = `${path}.curation-${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: statSync(path).mode & 0o777 });
  renameSync(tmp, path);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => !["--apply"].includes(arg)))
    throw new Error("Usage: curate-models.mjs [--apply]");
  const configPath = resolve(homedir(), ".paseo/config.json");
  const piPath = resolve(homedir(), ".pi/agent/settings.json");
  const configText = readFileSync(configPath, "utf8");
  const piText = readFileSync(piPath, "utf8");
  const config = JSON.parse(configText);
  const catalogs = await discoverCatalogs(config);
  const models = curateCatalogs(catalogs);
  const next = updatedSettings(config, JSON.parse(piText), models);
  for (const [provider, list] of Object.entries(models)) {
    console.log(`${provider}: ${list.length} choices; default ${list.find((m) => m.isDefault).id}`);
  }
  if (!args.includes("--apply")) return;
  const state = resolve(
    homedir(),
    ".local/state/ai-stack-upgrade",
    `model-curation-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  mkdirSync(state, { recursive: true, mode: 0o700 });
  chmodSync(state, 0o700);
  copyFileSync(configPath, resolve(state, "paseo-config.before.json"));
  copyFileSync(piPath, resolve(state, "pi-settings.before.json"));
  writeFileSync(resolve(state, "catalogs.json"), JSON.stringify(catalogs, null, 2));
  writeFileSync(resolve(state, "models.json"), JSON.stringify(models, null, 2));
  // Check both originals before either write, so concurrent edits fail without mutation.
  if (readFileSync(configPath, "utf8") !== configText || readFileSync(piPath, "utf8") !== piText)
    throw new Error("Configuration changed during discovery");
  replaceJson(configPath, next.config, configText);
  replaceJson(piPath, next.piSettings, piText);
  const output = execFileSync(resolve(homedir(), ".local/bin/paseo"), ["reload", "--json"], {
    encoding: "utf8",
    timeout: 60_000,
  });
  writeFileSync(resolve(state, "reload.json"), output);
  console.log(`Applied without restart. Backups and catalogs: ${state}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
