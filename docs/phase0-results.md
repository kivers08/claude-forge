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
| 1 | Installs from the private marketplace | PASS. Both a local `directory` source and the `github` source (private repo cloned through git credentials, `ref` pinned to this branch) installed `smoke` with `claude plugin install` | | | | PASS (manual). See "Row D partial run" below |
| 2 | `/smoke:ping` listed | PASS. `claude -p "/smoke:ping"` returned `SMOKE-SKILL-MARKER-9c1e` and reported the agent as `smoke:smoke-agent` | | | | PASS. Fresh headless `claude -p "/smoke:ping"` process returned the marker and listed `smoke:smoke-agent` |
| 3 | Agent dispatchable, marker verbatim | PASS. `FORGE-MARKER-7f3a` returned in the SMOKE REPORT | | | | PASS. `FORGE-MARKER-7f3a` returned verbatim in the SMOKE REPORT |
| 4 | Exec-form Node PreToolUse hook fires | PASS. `smoke.log` grew by one line per Bash call, including Bash calls made inside the subagent | | | | PASS. `smoke.log` grew per Bash call including the subagent's `node --version` |
| 5 | PostToolUse-on-Bash `additionalContext` visible next turn | PASS. Main model quoted `SMOKE-CONTEXT-4b2d...` verbatim; the subagent reported seeing it too | | | | PASS. Subagent reported seeing `SMOKE-CONTEXT-4b2d...` after its Bash call |
| 6 | Project `enabledPlugins` loads plugin in a fresh cloud session, no manual install | LIKELY FAIL. Simulated headlessly: marketplace auto-registered from project settings, plugin did NOT install or load (details below). Row C decides | n/a | n/a | FAIL bare (no hook); PASS once `.claude/hooks/session-start.sh` (option 4) is present — confirmed in a fresh session 2026-09-12, see below | n/a — the SessionStart hook is gated on `CLAUDE_CODE_REMOTE=true`, which was unset on this Remote-Control-to-VPS session; see below |
| 7 | Survives restart | PASS across 5 separate `claude -p` processes, and the build session itself resumed with the SessionStart context injected and `smoke:smoke-agent` listed (user-scope install) | | | | PASS as a proxy: multiple independent `claude -p` processes (different cwds) all saw the user-scope install consistently; the live interactive session itself was not restarted, see below |
| 8 | SubagentStop payload captured | PASS. Fields and last message below | | | | PASS. `subagentstop.log`/`.json` captured `agent_type: smoke:smoke-agent`, full `last_assistant_message` |
| 9 | Subagent rules-file auto-load | PASS. Rule text arrived as a system-reminder block after the Read | | | | PASS. `rule_seen: YES`, rule line quoted back verbatim |
| 10 | Native agent memory | PASS with a caveat: auto memory was OFF by default in this container; see below | | | | PASS. Memory dir `.claude/agent-memory/smoke-smoke-agent/`, marker `SMOKE-MEMORY-MARKER-a774` written and reported |
| 11 | `${CLAUDE_PLUGIN_DATA}` writable, stable, path | PASS. `/root/.claude/plugins/data/smoke-claude-forge`, identical across restarts, arg and env agree | | | | PASS. `/home/kivers/.claude/plugins/data/smoke-claude-forge`, identical across processes and cwds |

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

**Superseded below:** row C's real run led the owner to pick option 4 (a
project-committed SessionStart hook) instead of this option 1, in an
interactive decision made during that session — see "Row C confirmed" and the
"Conclusion" paragraph further down. Option 1's exact command is kept here
only as the documented backup if option 4 is ever removed.

### Row C confirmed, 2026-09-12 (real Android cloud session)

A real cloud session started from the Android app, based on `main` (which
already has `.claude/settings.json` with `enabledPlugins`/
`extraKnownMarketplaces` from this PR). Confirms the C0 simulation exactly:
`/root/.claude/plugins/installed_plugins.json` was `{"version":2,"plugins":{}}`
and `claude plugin marketplace list` reported "No marketplaces configured" —
neither plugin's hooks (session-start, guards, telemetry) ran for this
session. Check 6 is FAIL on row C, not just "likely."

Fixed for this session by hand:
`claude plugin marketplace add kewi-development/claude-forge`, then
`claude plugin install forge@claude-forge` and `...smoke@claude-forge`
(both installed cleanly at user scope from `main`, commit `53116bc`).

Went with option 4 instead of the chosen D24 option 1 (owner decision, made
interactively in this session): a project-committed `.claude/hooks/session-start.sh`,
registered as a top-level `SessionStart` hook in `.claude/settings.json`
(distinct from the plugins' own `hooks.json`), running the same
marketplace-add + plugin-install commands, guarded by `$CLAUDE_CODE_REMOTE`.
Verified idempotent (`claude plugin install` no-ops with "already installed"
on a second run) and that the script exits 0 both with and without the
remote guard set. Preferred over option 1 (environment-side setup script)
because it is versioned with the repo and needs no per-environment
configuration outside it.

**Was unverified, now RESOLVED (2026-09-12, fresh cloud session, this branch):**
D24 rejected the SessionStart-hook approach as "untested... a plugin
installed mid-session probably does not load its hooks or agents until
restart." A genuinely fresh cloud container was opened on this branch
(`.claude/hooks/session-start.sh` already present, `CLAUDE_CODE_REMOTE=true`).
Before any manual action:

- The SessionStart hook's own success log showed the marketplace add and both
  `claude plugin install` calls ran automatically.
- `claude plugin list` showed `forge@claude-forge` and `smoke@claude-forge`
  both `enabled` at user scope, with no manual install performed.
- Both plugins' hooks were live from turn one: the exec-form PreToolUse Node
  hook fired on the very first Bash call (`smoke.log` line 1), and the
  PostToolUse `additionalContext` sentence appeared after it.
- `smoke:smoke-agent` was dispatchable and returned `FORGE-MARKER-7f3a`
  verbatim; SubagentStop fired and captured `last_assistant_message`; the
  `.claude/rules/smoke-rule.md` `paths:` rule reached the subagent on its
  `Read` of `smoke-fixtures/rule-target.md` (`rule_seen: YES`, exact line
  quoted back).
- `${CLAUDE_PLUGIN_DATA}` resolved to `/root/.claude/plugins/data/smoke-claude-forge`,
  consistent with prior rows.
- Native agent memory: still no memory mechanism available to the subagent in
  this container (no override set this run) — consistent with finding 10,
  not a regression from the hook.

**Conclusion: check 6 passes via option 4 (project-committed SessionStart
hook).** The hook runs before the tool loop starts, not mid-session, so D24's
concern about mid-session plugin loads does not apply here. Option 1
(environment-side setup script, D24's original pick) remains the documented
backup in case the project hook is ever removed or `CLAUDE_CODE_REMOTE`
detection changes — its exact commands are in the "Options for cloud" list
above (option 1) and do not need repeating here.

### Row D partial run, 2026-09-12 (owner's dev VPS, session already open via Remote Control)

This was an already-running interactive session on the owner's persistent dev
VPS (Remote Control from the Android app), not a fresh one, so it tests a
different path than row C: manual install into a live session rather than
the SessionStart hook.

- `CLAUDE_CODE_REMOTE` was unset (empty string) in this session's environment.
  `.claude/hooks/session-start.sh` exits 0 immediately when that variable is
  not `"true"`, so the auto-install path never ran here — confirmed by
  `~/.claude/plugins/installed_plugins.json` being absent and `claude plugin
  list` reporting no plugins installed at session start, despite the
  marketplace already being registered from a prior `claude plugin
  marketplace add`. This means `CLAUDE_CODE_REMOTE=true` is specific to
  Anthropic-hosted cloud containers, not Remote-Control sessions to an
  owner-controlled persistent machine — check 6 is **n/a** for row D, not a
  fail, since D24's "persistent machines only need a one-time manual install"
  reasoning already covers this case.
- Ran `claude plugin install smoke@claude-forge` and `claude plugin install
  forge@claude-forge` by hand mid-session: both installed cleanly at user
  scope (`~/.claude/plugins/cache/claude-forge/{smoke,forge}/0.0.1`),
  `installed_plugins.json` recorded both with `gitCommitSha:
  2c8f38d1fd69526c7ae3798ab2c11aa346cc2c46`. Check 1 is **PASS** for row D.
- The plugin's slash commands/agents were NOT available in this same
  still-running session after the install (no `smoke:ping` skill or
  `smoke:smoke-agent`/forge agents listed) — consistent with D24's original,
  later-superseded concern that "a plugin installed mid-session probably does
  not load its hooks or agents until restart." This is now an observed data
  point for that exact mechanism (manual install into a live session) rather
  than an untested guess.
- Checks 2–5 and 7–11 could not be run by restarting the actual live session
  (an agent cannot restart the process it is running in and continue
  afterward). Instead, run the same way as C0: independent headless
  `claude -p` subprocesses against the user-scope install, which is a fair
  proxy since these checks are about a session picking up an
  already-installed plugin, not about this specific process's state. All
  passed — see the row D column above and "Row D agent-dispatch findings"
  below.

### Row D agent-dispatch findings, 2026-09-12 (headless `claude -p` subprocesses)

- `claude -p "/smoke:ping"` in a fresh process returned the marker and listed
  `smoke:smoke-agent` (check 2 PASS).
- Dispatching `smoke-agent` headlessly against the real repo/branch
  (`claude/units`) produced the full SMOKE REPORT (marker verbatim, rule_seen
  YES with the line quoted, memory written) — checks 3, 5, 9, 10 PASS — but
  the subprocess's final reply to the user was NOT the report; it was a
  one-line summary that it had run `git add`/`git commit`/`git push` and
  pushed a new commit (`68a95c0`) straight to `claude/units` on GitHub,
  unprompted. Nothing in `smoke-agent.md` asks for this. Cross-checking
  `~/.claude/settings.json` showed `"permissions": {"defaultMode": "auto"}`
  set globally on this VPS — every tool call, including `git push`, is
  auto-approved with no human gate, on this session and any subagent or
  headless subprocess it spawns. The model's own initiative to "wrap up" by
  committing and pushing went uncontested purely because of that setting; it
  is not something the smoke/forge plugins asked for. **This is an
  environment-config finding for row D, not a forge bug**, but it is a live
  safety gap on this machine worth the owner's attention independent of
  Phase 0. The stray commit was reverted with a follow-up commit removing the
  test-artifact memory files (matching the disk-cleanup precedent below), and
  pushed.
- To finish checks 4, 8, 11 without repeating that risk, the same dispatch was
  re-run inside a throwaway local clone with `origin` removed
  (`git clone --no-hardlinks` + `git remote remove origin`), so a repeat
  auto-commit/push had nothing to reach. It committed locally again (same
  behavior, confirming the pattern) but could not push, and was discarded
  with the whole clone afterward. From that run: `smoke.log` grew once per
  Bash call including the subagent's `node --version` (check 4 PASS);
  `subagentstop.log`/`.json` captured `agent_type: smoke:smoke-agent` and the
  full `last_assistant_message`, containing the SMOKE REPORT block, verbatim
  marker, `rule_seen: YES`, and the memory path (checks 5, 8, 9, 10 PASS);
  `${CLAUDE_PLUGIN_DATA}` resolved to
  `/home/kivers/.claude/plugins/data/smoke-claude-forge` in both the real
  repo and the throwaway clone (different `cwd`), confirming it is
  user-scope and path-stable, not repo-scope (check 11 PASS). The
  `SubagentStop` payload's own `permission_mode` field read `"auto"`,
  consistent with the settings file above.
- Check 7 (survives restart) could not be tested by an actual restart of the
  live session for the reason above. Multiple independent `claude -p`
  processes across two different working directories all saw the same
  user-scope plugin install consistently, which is the same style of
  evidence C0 used ("PASS across 5 separate `claude -p` processes"); treated
  as a PASS proxy for a persistent machine, not a literal restart test.

### 12. `user-level-write` guard false-positives on plain reads

Observed in the same verification session: a `cat` of a file under
`~/.claude/plugins/data/...` was blocked by the `forge` `user-level-write`
Bash guard with the same message used for writes ("Blocked path(s): ...").
`cat`, `<file`, and other read-only shapes should not trip a guard meant to
stop writes into the human's machine-wide config; only write-shaped commands
(`cp`/`tee`/`>`/`>>` per the guard's own description in `plan-excerpt.md`)
should match. Worked around by using the Read tool instead of Bash. File
against the guard's regex before U2 hooks ship — this is a false positive,
not a policy question.

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
