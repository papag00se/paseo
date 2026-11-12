# Fork inventory and upstream requests

Inventory of every custom code change this fork carries against `v0.14.0` (2026-11-01), whether it could live in a plugin today, what upstream already has on file, and ready-to-send drafts for what is missing. Nothing here has been posted yet.

## Inventory

| Fork change                                                                                                               | Code                                                         | Plugin today?                                                                                                                                                     | Upstream already                                                                                                                                                                                                                                                                                        | Action                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Project groups in the sidebar                                                                                             | app sidebar + store                                          | No. Plugins can add sidebar header/footer rows and screens, not regroup the native project list. The old `paseo-project-groups` plugin had to duplicate the list. | Idea [D4042](https://github.com/getpaseo/paseo/discussions/4042) (17 upvotes), [D4487](https://github.com/getpaseo/paseo/discussions/4487), [D6733](https://github.com/getpaseo/paseo/discussions/6733); slots idea [D7387](https://github.com/getpaseo/paseo/discussions/7387) does not cover grouping | Comment on D4042 (draft 1)                                                                                         |
| Staging, per-file stash, commit with a message from Changes                                                               | app git panel, protocol, server checkout                     | No. Plugins have no Git access and cannot add actions to Changes rows.                                                                                            | Plugin Git access [D3939](https://github.com/getpaseo/paseo/discussions/3939), pluggable VCS [D6333](https://github.com/getpaseo/paseo/discussions/6333); nothing asks for built-in staging                                                                                                             | New idea (draft 2), linking D3939                                                                                  |
| Open files externally from explorer, file menus, file tabs and assistant links; Open parent in editor; VS Code as default | app                                                          | No. Plugins cannot add entries to file, tab or link context menus.                                                                                                | [D6123](https://github.com/getpaseo/paseo/discussions/6123) (reveal/open with default app on file tabs), [D6130](https://github.com/getpaseo/paseo/discussions/6130) (link context menus)                                                                                                               | Comment on D6130 (draft 3); new plugin-slot idea (draft 4). VS Code default is a personal preference, not proposed |
| Momentum: per-workspace activity summaries in the hover card                                                              | server service, protocol, app hover card                     | Partly. Hooks can observe turns, but there is no hover-card slot and no access to the daemon's metadata model.                                                    | Hover-card slot is part of [D7387](https://github.com/getpaseo/paseo/discussions/7387); no request for summaries                                                                                                                                                                                        | New idea (draft 5) + comment on D7387 (draft 6)                                                                    |
| Stop closes a runtime whose interrupt is not acknowledged                                                                 | server lifecycle                                             | No (core lifecycle)                                                                                                                                               | Open p1 bug [#3749](https://github.com/getpaseo/paseo/issues/3749); only the dead-process half is fixed                                                                                                                                                                                                 | Comment with the fix (draft 7), offer PR                                                                           |
| `paseo agent archive/reload/detach/stop <id>` page the whole directory or only the first page                             | CLI                                                          | No                                                                                                                                                                | None ([PR6836](https://github.com/getpaseo/paseo/pull/6836) fixed `ls` only, closed)                                                                                                                                                                                                                    | New bug (draft 8)                                                                                                  |
| `server.paseo` for plugin entries                                                                                         | plugin contract + plugin process                             | Is the plugin enabler                                                                                                                                             | Bug [#5691](https://github.com/getpaseo/paseo/issues/5691) closed not planned; idea [D5990](https://github.com/getpaseo/paseo/discussions/5990)                                                                                                                                                         | Comment on D5990 (draft 9)                                                                                         |
| SDK `agent.delete()` + automatic retention plugin                                                                         | client SDK; plugin repo `paseo-agent-retention`              | Retention is a plugin; `delete()` is the missing enabler                                                                                                          | UI hard delete [D3503](https://github.com/getpaseo/paseo/discussions/3503)                                                                                                                                                                                                                              | New idea (draft 10)                                                                                                |
| Pi prompt preflight excluded from the 60 s RPC timeout                                                                    | Pi provider                                                  | No                                                                                                                                                                | None                                                                                                                                                                                                                                                                                                    | New bug (draft 11)                                                                                                 |
| Pi offers Minimal reasoning that maps to the same native effort as another level                                          | Pi provider                                                  | No                                                                                                                                                                | None                                                                                                                                                                                                                                                                                                    | New bug (draft 12)                                                                                                 |
| Strip `PI_*` session env from agent launches                                                                              | server launch config                                         | No                                                                                                                                                                | None                                                                                                                                                                                                                                                                                                    | New bug (draft 13)                                                                                                 |
| Per-agent systemd scopes (memory caps, CPU window, disk TMPDIR)                                                           | `scripts/fork/agent-scope*.sh` + provider commands in config | Already outside core (config wrapper)                                                                                                                             | Memory-pressure workflow [D5391](https://github.com/getpaseo/paseo/discussions/5391) is related, not the same                                                                                                                                                                                           | New idea (draft 14)                                                                                                |
| Model curation (newest per family, OmniRoute route list)                                                                  | `scripts/fork/curate-models.mjs`, `ai-stack-upgrade.sh`      | Already outside core (writes config)                                                                                                                              | Show/hide models UI [D5015](https://github.com/getpaseo/paseo/discussions/5015)                                                                                                                                                                                                                         | Comment on D5015 (draft 15)                                                                                        |
| Diff parsing for `diff.mnemonicPrefix` and no-prefix renames                                                              | server diff parser                                           | No                                                                                                                                                                | Fixed upstream by [#6536](https://github.com/getpaseo/paseo/pull/6536), in v0.14.0 (our [PR4233](https://github.com/getpaseo/paseo/pull/4233) was closed)                                                                                                                                               | Nothing to send. Check whether the fork parser changes can be dropped                                              |
| Cache-read recovery and Thinking-card merge                                                                               | app replica cache, stream types                              | No                                                                                                                                                                | Upstream `syncPending` now owns recovery                                                                                                                                                                                                                                                                | Nothing to send; fork keeps regression tests                                                                       |
| Tests local-only in Actions, desktop swap script                                                                          | CI, scripts                                                  | n/a                                                                                                                                                               | Fork policy                                                                                                                                                                                                                                                                                             | Not for upstream                                                                                                   |

## Drafts

### 1. Comment on D4042 (project groups)

> We run this in a fork with ~40 projects and it has held up for two months. What worked: groups are daemon-owned metadata (all clients see the same groups; directories never move), a project belongs to at most one group, groups and projects are reorderable by drag, a group can take an emoji/image icon, and the group header shows the most urgent agent state of its projects (working, needs input, failed). Ungrouped projects stay in the existing flat list, so nothing changes for people who never create a group. Happy to send this as a PR if the shape is right. If you would rather keep it out of core, the plugin route needs one new slot: a plugin-provided section model for the native project list (group headers + membership), since today a plugin can only render a second, duplicate list in the sidebar header.

### 2. New idea: stage, stash and commit from Changes

**Title:** Stage files, stash a single file, and commit with a message from the Changes pane

> **What I'm trying to do:** review an agent's changes and commit only the parts I accept, without leaving Paseo.
>
> **Today:** Changes shows working-tree diffs, but every file is all-or-nothing. To commit part of the work I switch to a terminal or another Git client.
>
> **What would help:**
>
> - Stage/unstage per file from the Changes row (and a staged vs unstaged split in the diff).
> - Stash one file (`git stash push -- <path>`) from the row menu, to park an unwanted change without discarding it.
> - Commit staged files with a message dialog (prefilled by the existing commit-message generation, editable), instead of commit-everything.
>
> We have run this in a fork since September (daemon checkout commands plus the row actions). If core is the wrong home, the plugin route needs both halves of [D3939](https://github.com/getpaseo/paseo/discussions/3939): Git read/write access in the plugin SDK, and plugin actions on Changes rows.

### 3. Comment on D6130 (link context menus)

> +1, and one more file-link action: **Open in <project's editor>** and **Open parent folder in <editor>**, using the same editor the project already picks for "Open in editor". We added these in a fork to file links in assistant messages, the file explorer, file menus and file tabs; the parent-folder variant is the one we use most, because an agent's link usually points at one file of a change spread across a folder.

### 4. New idea: plugin entries in file, tab and link menus

**Title:** Plugin API: add entries to file, file-tab and assistant-link context menus

> **What I'm trying to do:** add file actions from a plugin (open in a specific editor or app, reveal, send to another tool) where files already appear: the file explorer, file tab menus, and file links in assistant messages.
>
> **Today:** plugins can add Command Center items and file panels, but not context-menu entries on a file, so each of these actions needs a fork.
>
> **Suggested API:** `client.addFileAction({ id, title, icon, when?(file), onSelect({ file, workspace, paseo }) })`, where `file` carries the absolute path, workspace-relative path and whether it is a directory. Paseo owns the menus and placement; the same registration appears in all three surfaces. Related: [D7387](https://github.com/getpaseo/paseo/discussions/7387) for sidebar menus, [D6123](https://github.com/getpaseo/paseo/discussions/6123), [D6130](https://github.com/getpaseo/paseo/discussions/6130).

### 5. New idea: workspace activity summaries

**Title:** Workspace hover card: a one-line summary of what each agent is doing

> **What I'm trying to do:** glance at a workspace in the sidebar and know what its agents are doing and whether it moved since I last looked, without opening every tab.
>
> **What we built in a fork ("Momentum"):** after each turn the daemon writes a short summary per top-level agent with the metadata model (subagents excluded, since they report a parent's delegated step), and the workspace hover card lists them with a refresh button and a plain "no active agents" state.
>
> **Ask:** either this in core, or the two plugin pieces it needs: a hover-card slot ([D7387](https://github.com/getpaseo/paseo/discussions/7387)) and plugin access to the daemon's structured/metadata generation, so a plugin can summarize with the user's configured metadata model instead of starting an agent.

### 6. Comment on D7387 (sidebar slots)

> Another use for the hover-card slot: per-workspace activity summaries (one line per top-level agent, refreshed after each turn). We run this in a fork today. For it to move to a plugin, the slot needs the workspace id and its agents, and the plugin needs a way to call the daemon's metadata model (the "Workspace hover card: a one-line summary" idea).

### 7. Comment on #3749 (Stop not acknowledged)

> We hit the open half daily with Pi subagents: `clear_queue` (sent before `abort`) got no reply for 60 s, so `abort` was never sent, and every Stop returned "cancellation was not acknowledged" while the agent kept running. Archive works (it closes the runtime); Stop does not.
>
> The fix we run: when `cancelAgentRun` returns `refused`, the stop command closes the agent runtime instead of throwing. `closeAgent` already cancels waiters, settles the run and leaves a closed agent that resumes from its saved session on the next prompt, exactly like idle runtime collection. Stop then always stops; replace/reload/rewind still refuse. It is a few lines in `cancelAgentRunCommand` plus test updates. Happy to open the PR.

### 8. New bug: single-agent CLI commands read the whole agent directory

**Title:** bug(cli): `paseo agent archive <id>` pages the entire agent directory; `reload`/`detach`/`stop` only see the first 200 agents

> **What happened:** with ~19,000 stored agents (mostly archived subagents), each `paseo agent archive <id>` took minutes and parallel archives froze the daemon (event loop delay ~1 s, `fetch_agents_request` ~250 per 30 s). `archive` calls `fetchAllAgents({ includeArchived: true })` (≈100 pages of 200), and the daemon re-sorts every record for each page. `reload`, `detach` and `stop <id>` make a single unpaged `fetchAgents` call, so an agent beyond the first 200 is reported as not found.
>
> **Fix:** resolve one agent with `fetch_agent` (the daemon already matches ID, unique prefix and exact title), as `delete`, `inspect` and `logs` do. `stop --all/--cwd` should page with `fetchAllAgents`. We run this fix with a regression test that fails if a single-agent command pages the directory.

### 9. Comment on D5990 (Paseo API at plugin load)

> Same need here: a plugin that deletes idle agents on a timer has no caller, so it has no `PaseoApi` until some unrelated RPC or hook fires. The plugin process already builds and connects the API before calling `contribute()`, so we pass it in as `server.paseo` (one line in `plugin-process.ts` plus the contract field). Handlers and hooks keep receiving the same instance as `context.paseo`.

### 10. New idea: agent retention and `delete()` in the SDK

**Title:** Automatic cleanup of old agents, and `agent.delete()` in the SDK

> **What I'm trying to do:** keep the agent list bounded when agents spawn many subagents. In two weeks we accumulated ~19,000 stored agents; 4,500 were created in one day. Archive hides them but they stay on disk, load into memory at startup, and slow every directory request.
>
> **Ask:**
>
> 1. `agent.delete()` on SDK agent handles (the daemon already has `delete_agent_request`; only the SDK lacks it). This lets plugins implement retention.
> 2. Optionally, built-in retention settings: delete subagents N days after their last activity, delete top-level agents after M days, and optionally copy the provider's conversation log to a folder first.
>
> We run (1) in a fork and (2) as a plugin (`papag00se/paseo-agent-retention`). Related: [D3503](https://github.com/getpaseo/paseo/discussions/3503) (UI hard delete).

### 11. New bug: Pi prompt preflight times out

**Title:** bug(pi): prompt acceptance times out at 60 s while Pi compacts a large session, then the original prompt still runs

> Pi may summarize a large saved conversation before acknowledging the next `prompt`. Paseo applies the 60 s control-plane RPC timeout to that acknowledgement, reports failure, and Pi then continues the original prompt, so a retry duplicates the work. Explicit `compact` is already excluded from the timeout because Pi only answers once compaction is durable; prompt acceptance needs the same treatment (process exit and session close still reject the pending request). Fix + test available.

### 12. New bug: duplicate Minimal reasoning option for Pi

**Title:** bug(pi): Minimal reasoning is offered even when it maps to the same native effort as another level

> For models whose `thinkingLevelMap` sends `minimal` to the same native effort as `low` (e.g. OpenAI models through Pi), the picker shows Minimal and Low as two choices that behave identically. Offer Minimal only when it maps to a distinct native effort; keep accepting saved `minimal` preferences. Fix + test available.

### 13. New bug: parent Pi session identity leaks into launched agents

**Title:** bug: a daemon started from inside a Pi agent passes `PI_SESSION_ID` and friends to every agent it launches

> When Paseo is restarted from inside an agent, the daemon inherits that agent's `PI_CODING_AGENT`, `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL` and `PI_REASONING_LEVEL`, and every agent it launches inherits them too. Tools keyed on the Pi session id (for example per-agent browser tabs) then treat unrelated agents as one session. Paseo already strips Claude Code's session variables for the same reason; add the Pi ones to that list. Fix + test available.

### 14. New idea: per-agent resource isolation

**Title:** Run each agent in its own resource scope (memory cap, CPU set, private temp dir)

> **What happened:** 20+ agents each ran full test suites and local servers inside the desktop app's single process group; memory peaked at 40 GB + 12 GB swap and the app and daemon were killed together.
>
> **What we do:** wrap each provider command in a script that starts it in its own systemd user scope with `MemoryHigh`/`MemoryMax`/`MemorySwapMax`, `OOMPolicy=continue`, a rotating CPU window (so Jest/Vitest size their worker pools to it), and a private on-disk `TMPDIR`. A runaway agent is throttled or killed alone.
>
> **Ask:** a supported per-agent launch wrapper or resource settings (Linux cgroups/systemd scopes, macOS equivalents where possible), instead of each user editing every provider command. Related: [D5391](https://github.com/getpaseo/paseo/discussions/5391).

### 15. Comment on D5015 (show/hide models)

> +1. A rule-based option would cover our case without per-model clicking: "show only the newest version of each model family" per provider. We do this today with a script that rewrites provider model lists after every CLI update, which breaks whenever a family is renamed.
