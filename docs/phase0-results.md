# Phase 0 results

Blocking smoke test for the `forge` build (D16). Rows are environments, checks
are numbered as in `plan-excerpt.md`. Fill a cell with PASS / FAIL / n/a plus a
one-line note. Owner rows stay blank until the owner runs them.

Rows:
- **A** Linux dev box terminal (owner)
- **B** WSL2 on the Windows box (owner)
- **C** cloud session started from the Android app (owner starts; checks run inside)
- **D** Remote Control from the Android app to the VPS (owner)
- **C0** this build session's cloud container, driven headlessly with `claude -p`
  after `claude plugin marketplace add <checkout>` + `claude plugin install
  smoke@claude-forge`. Not a substitute for C: the marketplace was added by hand
  from a local directory, so it says nothing about check 6.

Claude Code in C0: 2.1.268, Node v22.22.2, Linux, running as root,
`HOME=/root`.

## Matrix

| # | Check | C0 (this container) | A | B | C | D |
|---|-------|---------------------|---|---|---|---|
| 1 | Installs from the private marketplace | PASS. Both a local `directory` source and the `github` source (private repo cloned through git credentials, `ref` pinned to this branch) installed `smoke` with `claude plugin install` | | | | |
| 2 | `/smoke:ping` listed | PASS. `claude -p "/smoke:ping"` returned `SMOKE-SKILL-MARKER-9c1e` and reported the agent as `smoke:smoke-agent` | | | | |
| 3 | Agent dispatchable, marker verbatim | PASS. `FORGE-MARKER-7f3a` returned in the SMOKE REPORT | | | | |
| 4 | Exec-form Node PreToolUse hook fires | PASS. `smoke.log` grew by one line per Bash call, including Bash calls made inside the subagent | | | | |
| 5 | PostToolUse-on-Bash `additionalContext` visible next turn | PASS. Main model quoted `SMOKE-CONTEXT-4b2d...` verbatim; the subagent reported seeing it too | | | | |
| 6 | Project `enabledPlugins` loads plugin in a fresh cloud session, no manual install | LIKELY FAIL. Simulated headlessly: marketplace auto-registered from project settings, plugin did NOT install or load (details below). Row C decides | n/a | n/a | | n/a |
| 7 | Survives restart | PASS across 5 separate `claude -p` processes, and the build session itself resumed with the SessionStart context injected and `smoke:smoke-agent` listed (user-scope install) | | | | |
| 8 | SubagentStop payload captured | PASS. Fields and last message below | | | | |
| 9 | Subagent rules-file auto-load | PASS. Rule text arrived as a system-reminder block after the Read | | | | |
| 10 | Native agent memory | PASS with a caveat: auto memory was OFF by default in this container; see below | | | | |
| 11 | `${CLAUDE_PLUGIN_DATA}` writable, stable, path | PASS. `/root/.claude/plugins/data/smoke-claude-forge`, identical across restarts, arg and env agree | | | | |

## Findings worth carrying into the build

### 8. SubagentStop payload (observed, 2.1.268)

Fields, sorted:

```
agent_id, agent_transcript_path, agent_type, background_tasks, cwd, effort,
hook_event_name, last_assistant_message, permission_mode, prompt_id,
scratchpad_dir, session_crons, session_id, stop_hook_active, transcript_path
```

- `last_assistant_message` IS present and holds the subagent's full final
  text (411 chars in the test, the whole SMOKE REPORT block).
- `agent_type` for a plugin agent is namespaced: `smoke:smoke-agent`.
- `scratchpad_dir`, `effort`, `prompt_id` are present but not in the docs' example.
- The docs now document this event's input (fact 4 in `decisions.md` is
  updated). Output/blocking is still undocumented. D15 stands: auto-filing the
  `### LEARNING` block from SubagentStop is feasible but stays an experiment.

### 9. Rules reach subagents

The subagent Read `smoke-fixtures/rule-target.md` and the rule from
`.claude/rules/smoke-rule.md` (`paths: ["smoke-fixtures/**"]`) appeared as a
separate system-reminder block titled with the rule file path. So path-scoped
rules DO apply inside subagents on the Read tool. Not tested: Edit/Write/Bash
triggering. D7's PostToolUse injector remains the mechanism for Bash.

### 10. Native agent memory

- Memory directory for a plugin agent with `memory: project` is
  `.claude/agent-memory/<plugin>-<agent>/`, i.e. `smoke-smoke-agent`, NOT
  `<agent>` alone. Fact 8 in `decisions.md` is corrected. `forge` agents will
  land at `.claude/agent-memory/forge-<name>/`.
- With memory active the agent gets Read/Write/Edit automatically and its
  system prompt contains `## MEMORY.md` plus the file's content. Second
  dispatch received the index line written by the first, verbatim.
- CAVEAT: in this cloud container auto memory was off by default with no
  `autoMemoryEnabled` setting and no env var set. The first dispatch reported
  "no memory tool". Setting `CLAUDE_CODE_DISABLE_AUTO_MEMORY=0` on the
  `claude -p` process turned it on. Owner rows should record whether memory is
  on without any override; if cloud sessions have it off, D4's native-memory
  path silently no-ops there and the hand-rolled spokes are the only memory.
- The smoke agent's memory files were deleted before commit; they were test
  artifacts.

### 11. Plugin data and plugin root

- `${CLAUDE_PLUGIN_DATA}` = `~/.claude/plugins/data/<plugin>-<marketplace>`.
  Passed as an arg AND exported as env; both agree.
- With a `directory` marketplace source, `${CLAUDE_PLUGIN_ROOT}` was the
  checkout itself (`/home/user/claude-forge/plugins/smoke`), not the cache, so
  edits took effect without reinstalling. With a `github` source expect the
  cache path `~/.claude/plugins/cache/claude-forge/smoke/<version>/`.

### 6. Check 6 simulation (headless, this container)

Setup: user-level plugin and marketplace removed, trust flag for the folder
written into `~/.claude.json`, project `.claude/settings.json` as the only
source with `ref` temporarily pinned to this branch (the GitHub source
otherwise clones `main`, which has no plugins until this PR merges).

Result of `claude -p "/smoke:ping"`:
- `extraKnownMarketplaces` WAS honored: the marketplace registered itself and
  the private repo was cloned to `~/.claude/plugins/marketplaces/claude-forge`
  at the pinned ref, with both plugin directories present.
- `enabledPlugins` did NOT install the plugin: `claude plugin list` showed
  nothing installed and the skill was "Unknown command".
- A manual `claude plugin install smoke@claude-forge` from that same
  GitHub-sourced marketplace then worked, and the plugin ran from
  `~/.claude/plugins/cache/claude-forge/smoke/0.0.1`.

Reading: a relative-path plugin inside a GitHub-sourced marketplace is treated
as external for the v2.1.195 rule, so project settings alone do not install
it. This was headless, not an interactive cloud session, so row C is still the
deciding run, but expect it to fail the same way.

Consequence if row C confirms: the "clone the repo and the plugin is just
there" model does not hold for fresh cloud containers. Persistent machines
(rows A, B, D) only need a one-time `claude plugin install` per machine.

Options for cloud (**owner chose option 1 on 2026-09-11; recorded as D24**):
1. Cloud environment setup script runs
   `claude plugin marketplace add kewi-development/claude-forge && claude plugin install forge@claude-forge`
   before each session. Environment-side, not repo-side; no vendoring. Needs
   the environment's git credentials to reach the private repo (the clone
   above worked in this container).
2. `CLAUDE_CODE_PLUGIN_SEED_DIR` pre-populated in the cloud environment image.
   Same shape as option 1 but static; goes stale unless rebuilt.
3. Vendored copy (`.claude/vendor/forge/`) per project, hooks registered by
   `${CLAUDE_PROJECT_DIR}` path in project settings. Works everywhere with no
   install step; costs a sync step on every forge release and duplicates the
   plugin into every project.
4. A project SessionStart hook that runs the install commands. Untested;
   hooks and agents from a plugin installed mid-session probably do not load
   until restart, so this likely covers skills only.

**Chosen: option 1 (D24).** The cloud environment runs
`claude plugin marketplace add kewi-development/claude-forge && claude plugin
install forge@claude-forge` before each session. Option 3 (vendoring) stays the
documented fallback if a real cloud row shows option 1 failing. Row C still runs
— it decides whether check 6 fails as predicted, and whether auto memory is on.

### Why the real row C could not run from this session

This session's container started before `.claude/settings.json` existed, so
the project-settings path never ran here interactively. The docs say (settings-reference,
`enabledPlugins`): "Enabling a plugin from an external source such as a
GitHub repository or npm package in a project's `.claude/settings.json`
doesn't install it for other people" (v2.1.195+), while discover-plugins says
to "declare the plugin under `enabledPlugins` in `.claude/settings.json` for
cloud sessions". Whether a relative-path plugin inside a GitHub-sourced
marketplace counts as "external" is not stated. Row C answers it: open a NEW
cloud session on this branch (or on `main` after merge), run `/smoke:ping`,
and run `claude plugin list`.

If C fails on 6, two fallbacks in order of preference:
1. Register the marketplace in this repo's settings with a `directory` source
   (`{"source":"directory","path":"."}`) for THIS repo only. That proves
   nothing for other projects, so it is a diagnostic, not a fix.
2. The vendored copy described in `decisions.md` (`.claude/vendor/forge/` with
   hooks registered by `${CLAUDE_PROJECT_DIR}` path).

## Owner run sheet

Per row, after `git pull` on this branch (or after merge):

1. Open a session in the repo. Note whether `/smoke:ping` is listed without any
   manual install (check 6 for C; check 1 for the rest). If not, run
   `claude plugin marketplace add kewi-development/claude-forge` then
   `claude plugin install smoke@claude-forge` and note that you had to.
2. Run `/smoke:ping` (2).
3. Run any Bash command, then ask: "quote any additional context that came with
   the last tool result" (4, 5). `cat` the `smoke.log` under the data dir the
   session-start line names (11).
4. Dispatch `smoke:smoke-agent` with "Follow your definition steps and return
   the SMOKE REPORT block" (3, 8, 9, 10). Then `cat` `subagentstop.log` in the
   data dir (8) and `ls .claude/agent-memory/` (10). Delete the memory dir
   afterwards, or commit it if you want the evidence.
5. Restart Claude Code; confirm `/smoke:ping` still lists and the data dir path
   in the new session-start line is unchanged (7, 11).

Paste results into the matrix above.
