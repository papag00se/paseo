# Jesse's Paseo fork

`papag00se/paseo` merges upstream `getpaseo/paseo` 0.11.2 (`v0.11.2`) into the existing fork history. The desktop app in `~/.local/opt/paseo/app` is built from this repo's `main`. Plugins live in their own repos (listed below), not here.

## Preserved fork changes

| Area               | Commits                                                     | What it does                                                                                                                                                                                                                                                                                   |
| ------------------ | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project groups     | `42bf99d41` `98958d673` `42fa951ec`                         | Group projects in the workspace sidebar, reorder groups, lazy group icons. Replaces the old `paseo-project-groups` plugin.                                                                                                                                                                     |
| Editor             | `99794dc05` `733e79f9d` `4beefc743`                         | VS Code is the default editor; open files externally from workspace surfaces; "Open parent in editor" in file menus.                                                                                                                                                                           |
| Git panel          | `4a17290c0` `ceffedbdf` `bd2de2063` `41d7d092e` `ddfc88f50` | Stage files, stash single files, controlled commits; diff rows refresh when staging changes.                                                                                                                                                                                                   |
| Git diffs (server) | `38471b154` `5c85ae8f9`                                     | Parse diffs made with `diff.mnemonicPrefix`; disambiguate no-prefix renames.                                                                                                                                                                                                                   |
| Momentum           | `dd7a96fa3` `3e9307060` `fb379a604` `830a130d1` `5a1c49f87` | Per-workspace agent summaries with refresh; subagents excluded; explains when nothing is active.                                                                                                                                                                                               |
| Markdown tabs      | `2c3ab1d10` `f00dba24e` `b6f2685e7`                         | Crossnote renderer for desktop Markdown tabs and a Preview context action; explicitly opened external files use single-document plugin grants.                                                                                                                                                 |
| Cache recovery     | `d1da0a67a`                                                 | One unreadable cached conversation no longer blocks all timeline loading; reasoning chunks merge into one Thinking card. Upstream's `syncPending` now owns rejected-write recovery; the fork's regression tests remain. See [incident](incidents/2026-10-06-cache-read-failure/ROOT-CAUSE.md). |

List the original additions with `git log --oneline 818658520..67e0f55dd`. Compare the current fork against upstream with `git diff v0.11.2..main`.

The 0.11.2 merge keeps Momentum inside upstream's shared hover-card component and retains the wider card. Project groups coexist with upstream's sidebar separators. Startup failure stops Momentum and clears upstream's local credential. Native Markdown keeps the fork's scroll container; desktop still uses Crossnote. External desktop file tabs require the Markdown Preview plugin's `preview.file.open` contract; workspace tabs keep their existing preview behavior. The file-grant boundaries and linked-resource limits are owned by the [plugin reference](https://github.com/papag00se/paseo-markdown-preview/blob/main/docs/REFERENCE.md#desktop-file-tab-contract).

## Model picker policy

Jesse wants only the newest version of each Claude/OpenAI model family. The workhorse defaults are newest Opus for Claude and Pi, and newest Sol for Codex. New family names are included automatically; if either workhorse family disappears, review its replacement rather than silently defaulting to the most expensive model. Existing agents keep their chosen models. OmniRoute exposes only Free, Best Coding, Smart, and the local Qwen route; its internal failover connections are not deleted. Both Paseo's model list and Pi's custom-model definitions follow that four-route policy. Other Pi providers are unchanged.

`scripts/fork/ai-stack-upgrade.sh` owns the installed `~/.local/bin/ai-stack-upgrade` launcher. It runs `curate-models.mjs --apply` after CLI/catalog updates. After a manual CLI or custom Paseo update, run `ai-stack-upgrade --models-only` too. This refreshes the lists and Pi's startup default without performing any software or system update.

The curator creates independent provider clients with model overrides removed, so a previous curated list cannot hide the next release. Claude also includes newly available Anthropic IDs from Pi's refreshed catalog, without copying Pi-specific effort settings to the Claude CLI. Config/session settings are backed up under `~/.local/state/ai-stack-upgrade/model-curation-*` before atomic writes and `paseo reload`; no daemon restart or inference request is needed. Run its focused tests with `node --test scripts/fork/curate-models.test.mjs`.

Pi reasoning choices follow its refreshable per-model catalog, not model-name lists. Minimal requires an explicit mapping to a distinct native effort; missing metadata or an alias of another available effort does not qualify. Existing saved reasoning preferences are not migrated or rejected.

## Pi prompt preflight

Pi can summarize a large saved conversation before acknowledging the next prompt. The fork excludes prompt acceptance from the 60-second control-plane timeout, matching the existing explicit-compaction contract. Otherwise Paseo reports failure while Pi continues the original prompt, inviting duplicate work. Regression coverage waits five simulated minutes and checks that process exit and session close still reject pending prompts. State-query timeouts remain bounded.

## Build and install the desktop app

```bash
cd ~/src/paseo && npm ci
npm run build:desktop -- --linux dir                    # output: packages/desktop/release/linux-unpacked
test ! -e ~/.local/opt/paseo/app.new                      # do not overwrite another staged build
cp -a packages/desktop/release/linux-unpacked ~/.local/opt/paseo/app.new
~/.local/opt/paseo/swap-in-new-build.sh                  # quits Paseo, swaps, relaunches; keeps app.old
```

`~/.local/opt/paseo/swap-in-new-build.sh` is a link to [`scripts/fork/swap-in-new-build.sh`](../../scripts/fork/swap-in-new-build.sh). The CLI `~/.local/bin/paseo` points into the installed app.

The bundled updater still names `getpaseo/paseo`. Installing an upstream update would replace these changes. Rebuild from this repo instead.

## Plugins (separate repos, loaded from `~/Work`)

| Plugin            | Repo                                | Notes                                                         |
| ----------------- | ----------------------------------- | ------------------------------------------------------------- |
| Chrome Bridge     | `papag00se/paseo-chrome-bridge`     | Plugin is `plugin/`; also provides the web/desktop MCP tools. |
| Juke              | `papag00se/paseo-juke-plugin`       |                                                               |
| Role Orchestrator | `papag00se/paseo-role-orchestrator` |                                                               |
| Overcommitted     | `papag00se/paseo-overcommitted`     |                                                               |
| Markdown Preview  | `papag00se/paseo-markdown-preview`  |                                                               |
| Project Groups    | `papag00se/paseo-project-groups`    | Retired: built into this fork.                                |

Plugin paths are in `~/.paseo/config.json`. Changing a path needs `paseo plugin remove <id>` then `paseo plugin install <dir>` (a daemon restart otherwise). `remove` deletes that plugin's `~/.paseo/plugin-settings/<id>`, so back it up first.
