import assert from "node:assert/strict";
import { test } from "node:test";
import { curateCatalogs, latestModels, updatedSettings } from "./curate-models.mjs";

const model = (id) => ({
  id,
  label: id,
  thinkingOptions: [{ id: "high", label: "High", isDefault: true }],
});
function catalogs() {
  return {
    claude: {
      models: ["claude-fable-5-1", "claude-opus-5", "claude-opus-5-5", "claude-haiku-5-5"].map(
        model,
      ),
    },
    codex: { models: ["gpt-6-astra", "gpt-6-sol", "gpt-6.1-sol", "gpt-6-luna"].map(model) },
    pi: {
      models: [
        "anthropic/claude-fable-5-1",
        "anthropic/claude-opus-5",
        "anthropic/claude-opus-5-5",
        "anthropic/claude-haiku-5-5",
        "openai-codex/gpt-6-astra",
        "openai-codex/gpt-6-sol",
        "openai-codex/gpt-6.1-sol",
        "openai-codex/gpt-6-luna",
        "openai-codex/gpt-5.3-codex-spark",
        "omniroute/auto/coding",
      ].map(model),
    },
  };
}

test("latest versions compare numerically and discard dated/context duplicates", () => {
  const selected = latestModels(
    [
      "claude-opus-5-9",
      "claude-opus-5-10-20261012",
      "claude-opus-5-10[1m]",
      "claude-opus-5-10",
    ].map(model),
    "claude",
    "opus",
  );
  assert.deepEqual(
    selected.map((m) => m.id),
    ["claude-opus-5-10"],
  );
});

test("new families appear automatically and newest Sol beats 6 even if listed later", () => {
  const selected = latestModels(
    ["gpt-6.1-sol", "gpt-6-sol", "gpt-7-quartz", "gpt-7.2-quartz", "gpt-6-astra"].map(model),
    "codex",
    "sol",
  );
  assert.deepEqual(
    selected.map((m) => m.id),
    ["gpt-6.1-sol", "gpt-7.2-quartz", "gpt-6-astra"],
  );
  assert.equal(selected.find((m) => m.isDefault).id, "gpt-6.1-sol");
});

test("Pi mirrors latest native families, defaults to Opus, and keeps router models", () => {
  const result = curateCatalogs(catalogs());
  assert.equal(result.claude.find((m) => m.isDefault).id, "claude-opus-5-5");
  assert.equal(result.codex.find((m) => m.isDefault).id, "gpt-6.1-sol");
  assert.equal(result.pi.find((m) => m.isDefault).id, "anthropic/claude-opus-5-5");
  assert.equal(
    result.pi.some((m) => m.id === "openai-codex/gpt-6-sol"),
    false,
  );
  assert.equal(
    result.pi.some((m) => m.id === "openai-codex/gpt-5.3-codex-spark"),
    false,
  );
  assert.equal(
    result.pi.some((m) => m.id === "omniroute/auto/coding"),
    true,
  );
  assert.deepEqual(result.pi[0].thinkingOptions, [{ id: "high", label: "High", isDefault: true }]);
  for (const models of Object.values(result))
    assert.equal(models.filter((m) => m.isDefault).length, 1);
});

test("a refreshed Pi catalog advances native Claude before its manifest updates", () => {
  const input = catalogs();
  input.pi.models.push(model("anthropic/claude-opus-5-6"), model("anthropic/claude-lyric-6"));
  const result = curateCatalogs(input);
  assert.equal(result.claude.find((m) => m.isDefault).id, "claude-opus-5-6");
  assert.equal(result.pi.find((m) => m.isDefault).id, "anthropic/claude-opus-5-6");
  assert.equal(
    result.claude.some((m) => m.id === "claude-lyric-6"),
    true,
  );
  assert.equal(
    result.claude.some((m) => m.id === "claude-opus-5-5"),
    false,
  );
  assert.equal(result.claude.find((m) => m.id === "claude-opus-5-6").thinkingOptions, undefined);
});

test("missing Pi Opus or missing workhorse stops the entire plan", () => {
  const input = catalogs();
  input.pi.models = input.pi.models.filter((m) => m.id !== "anthropic/claude-opus-5-5");
  assert.throws(() => curateCatalogs(input), /Pi cannot use/);
  assert.throws(() => latestModels([model("gpt-6-astra")], "codex", "sol"), /no sol model/);
});

test("settings preserve unrelated overrides, remove stale additions, and do not mutate inputs", () => {
  const config = {
    plugins: { enabled: true },
    agents: {
      providers: {
        pi: { command: ["custom-pi"], additionalModels: [model("old")] },
        custom: { enabled: true },
      },
    },
  };
  const settings = {
    defaultProvider: "openai-codex",
    defaultModel: "gpt-6-sol",
    defaultThinkingLevel: "high",
    extensions: ["custom"],
  };
  const before = structuredClone({ config, settings });
  const next = updatedSettings(config, settings, curateCatalogs(catalogs()));
  assert.deepEqual({ config, settings }, before);
  assert.deepEqual(next.config.agents.providers.pi.command, ["custom-pi"]);
  assert.equal("additionalModels" in next.config.agents.providers.pi, false);
  assert.deepEqual(next.config.agents.providers.custom, { enabled: true });
  assert.deepEqual(next.config.plugins, config.plugins);
  assert.equal(next.piSettings.defaultProvider, "anthropic");
  assert.equal(next.piSettings.defaultModel, "claude-opus-5-5");
  assert.equal(next.piSettings.defaultThinkingLevel, "high");
  assert.deepEqual(next.piSettings.extensions, ["custom"]);
});

test("each update replaces prior curated versions using a fresh catalog", () => {
  const first = updatedSettings({}, {}, curateCatalogs(catalogs()));
  const second = catalogs();
  second.codex.models.push(model("gpt-6.2-sol"));
  second.pi.models.push(model("openai-codex/gpt-6.2-sol"));
  const next = updatedSettings(first.config, first.piSettings, curateCatalogs(second));
  assert.equal(
    next.config.agents.providers.codex.models.find((m) => m.isDefault).id,
    "gpt-6.2-sol",
  );
  assert.equal(
    next.config.agents.providers.codex.models.some((m) => m.id === "gpt-6.1-sol"),
    false,
  );
  assert.equal(
    next.config.agents.providers.pi.models.some((m) => m.id === "openai-codex/gpt-6.1-sol"),
    false,
  );
});
