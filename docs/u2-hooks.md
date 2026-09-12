# U2 — the hook unit

What shipped, what each guard decides, and the judgement calls made while
building it. Companion to `plan-excerpt.md` (the design) and `decisions.md`
(the settled decisions). Everything here is Node stdlib only, exec form, D11.

## Files

```
plugins/forge/hooks/
  hooks.json              registration (exec form, node, ${CLAUDE_PLUGIN_ROOT})
  guards.json             declarative guard manifest {name, match, script}
  pre-bash.js             PreToolUse Bash: the guard dispatcher
  pre-write.js            PreToolUse Edit|Write|MultiEdit|NotebookEdit
  pre-merge-mcp.js        PreToolUse mcp__github__merge_pull_request
  post-bash-rules.js      PostToolUse Bash: the D7 rules injector
  stop-git-check.js       Stop: uncommitted / unpushed work
  session-start.js        SessionStart: the D6 context injector
  telemetry.js            PreToolUse Skill|Task|Agent: the D10 usage log
  lib/{io,config,segment-split,glob}.js
  guards/*.js             one file per guard
  tests/{run.js,cases.json,payloads/,fixtures/}
```

`node plugins/forge/hooks/tests/run.js` runs 53 cases. `--only <substring>`
narrows; `--plugin <dir>` points it at another plugin.

## The guards

| Guard | Verdict | Fires on | Notes |
| --- | --- | --- | --- |
| `merge-gate` | deny | `gh pr merge`, `git merge`, or the MCP merge, when the DESTINATION is `git.baseBranch` | needs `.git/claude-human-merge-ok` newer than 15 min, plus `--squash` |
| `user-level-write` | deny | writes into `~/.claude` from Bash or the file tools | the project's own `.claude/` is fine |
| `pr-create` | deny | `gh pr create` without `--draft` | off when `git.draftPrRequired` is false |
| `git-refspec` | deny | `git push origin <bare-branch>` | `-u`, `src:dst`, `refs/heads/…`, bare `git push`, deletes all pass |
| `worktree-commit` | deny | `git commit` when the branch is checked out in another worktree | |
| `csv-parse` | deny | `awk -F,` / `cut -d,` against a `.csv` operand | |
| `ci-owned-command` | deny | `commands.ciOwned` regexes | no config, no guard |
| `slow-command` | remind | `commands.slow` regexes | never denies |
| `delegation` | remind | Bash writes outside `delegation.inlineAllow` | never denies |

Order is the manifest order; the first deny wins and stops the dispatcher.
Reminders from every guard are concatenated into one `additionalContext` note.

## Judgement calls made here — review these

These were not settled in `decisions.md`. Each is a default chosen to keep the
build moving; change any of them and the code follows.

1. **Merge-marker freshness = 15 minutes.** An existing-but-old marker is
   yesterday's decision, not today's, so age is checked and not just existence.
   15 minutes is a guess at "the human said merge and is still here".
2. **Every merge path is gated only on the DESTINATION being `git.baseBranch`
   — corrected 2026-09-12.** Originally `gh pr merge` and the MCP merge were
   gated unconditionally, on the theory that any PR/API merge was risky
   enough to always confirm. The owner introduced an integration-branch
   workflow (child units merge into an owner-chosen non-`main` branch, which
   merges to `main` once at the end) and pointed out that requiring the human
   marker for every child merge defeated the point of not needing a human in
   the loop for those. Decisions.md's own working-style rule already said
   "never merge to `main` without the owner's explicit merge command" — the
   old code was stricter than the stated policy, not aligned with it. Fixed:
   `gh pr merge` and the MCP merge now resolve the PR's actual destination via
   `gh pr view --json baseRefName` (best-effort; unresolvable — no `gh` on
   PATH, no network, malformed payload — fails SAFE to "assume the base
   branch", i.e. still gated) and only gate when that destination is
   `git.baseBranch`. A local `git merge` was already scoped this way (gated
   only when `git.baseBranch` is checked out) and needed no change. This
   still leaves one hole: a local merge on a feature branch that is then
   fast-forwarded elsewhere.
3. **`git-refspec` reads as "require an explicit destination".** D-level intent
   was only "deny bare local-branch refspec pushes". The guard accepts `-u`,
   `src:dst` and `refs/heads/…`, which matches the house `git push -u origin
   <branch>` convention. If the real intent was narrower, this over-denies.
4. **The MCP merge hook fails CLOSED.** Every other hook fails open on a
   malformed payload. This one denies, because "we could not verify the human
   said merge" must not resolve to "merge it". Cost of being wrong: one denied
   merge and a re-run.
5. **`projectDir` returns null rather than `process.cwd()`.** A hook's own
   working directory is not guaranteed to be the project; falling back to it
   turned an unreadable payload into "inspect whatever repo we are standing in".
   Callers decide what null means — Stop goes quiet, the merge gate denies.
6. **Quoted text never triggers a deny.** `echo "gh pr create"` is not a PR
   create. The manifest regexes are a prefilter over the raw segment; every
   denying guard confirms the hit against UNQUOTED tokens.
7. **Rules are injected once per rule per session**, at most 3 per Bash call,
   4 KB per rule. Re-injecting the same rule on every Bash call is context burn.
8. **Telemetry matches `Skill|Task|Agent`.** UNVERIFIED: the tool name for an
   agent spawn is undocumented and has differed between surfaces. The hook
   records `tool_name` verbatim instead of assuming either, so the log stays
   correct whichever it is. Confirm against a real transcript before
   `/forge:audit-framework` relies on the counts.

## Known limits

- `segment-split.js` is a lexer, not a shell: no heredocs, no process
  substitution, no arithmetic expansion, no aliases. A guard that matters fails
  closed; a guard that misses is a reminder. Never read a miss as proof of
  safety.
- `glob.js` supports `**`, `*`, `?`, `{a,b}`, `[abc]`, `[!abc]`. No extglob, no
  leading-`!` negation.
- Native Windows without Git for Windows uses the PowerShell tool, which no
  Bash guard ever sees (D13). Unsolved, and not solvable from a Bash hook.
- Hook ordering across scopes (project vs plugin) is not fully documented, so
  two plugins denying the same call have an undefined winner.
