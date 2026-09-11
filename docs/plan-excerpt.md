# forge — plan excerpt

Config contract, plugin surface, and the Phase 0 matrix. Companion to
`decisions.md`. Units: U1 skeleton, Phase 0 smoke, U2+ real build.

## `.claude/forge.json` contract

Strict JSON, validated against `plugins/forge/schema/forge.schema.json`
(draft 2020-12, `additionalProperties: false` at every level, every key has a
`description`). Values are a project's own; none live in the plugin.
`/forge:bootstrap` writes it plus a sibling `forge.md` explaining each key.

| Key | Type | Meaning |
| --- | --- | --- |
| `taskFiles.lessons` | string path | Lessons file (grep-only, Index Contract) |
| `taskFiles.todo` | string path | Todo file (open-items injection exception) |
| `taskFiles.sprint` | string path | Sprint file |
| `taskFiles.spokesDir` | string path | Directory of hand-rolled memory spokes |
| `taskFiles.caps` | `{lessons, todo, sprint, spoke}` ints | Line caps, e.g. 400/1000/100/100 |
| `taskFiles.injectionBudget` | int bytes | Total session-start injection budget, e.g. 8192 |
| `taskFiles.injectionMode` | `{<file>: "index" \| "open-items" \| "head-N"}` | Per-file injection mode |
| `taskFiles.decisionsLog` | string path | Decisions log |
| `taskFiles.auditsDir` | string path | Audit output directory |
| `git.baseBranch` | string | Base branch for PRs |
| `git.branchPrefix` | string | Prefix for work branches |
| `git.worktreeDir` | string | Where worktrees are created |
| `git.draftPrRequired` | bool | Guard: `gh pr create` must use `--draft` |
| `git.squashOnly` | bool | Guard: merges must be squash |
| `commands.ciOwned` | string[] regex | Commands CI owns; denied locally |
| `commands.scopedTestExample` | string | Example of a scoped test command |
| `commands.slow` | string[] regex | Must run in background |
| `commands.ci` | `{workflow, triggerBranches[], runner, pathsIgnore[]}` | CI description |
| `commands.lint` | string | Lint command |
| `commands.deploy` | string | Free text, may say "owner-only" |
| `readDiscipline.grepOnly` | string[] globs | Files never read whole |
| `readDiscipline.maxDocLines` | int | Max lines per doc read |
| `readDiscipline.maxBytes` | int | Max bytes per read |
| `delegation.inlineAllow` | string[] globs | Paths the coordinator may edit inline |
| `delegation.delegatedPaths` | string[] globs | Paths that must be delegated |
| `agents.<name>.model` | string | Model override for that agent |
| `agents.<name>.budget` | int | Tool-call budget override |
| `agents.<name>.domainSkills` | string[] | Skills to preload |
| `agents.<name>.spoke` | string path | Hand-rolled memory spoke |
| `agents.doc-updater.docTargets` | string[] | Docs the doc-updater maintains |
| `agents.reviewer.extraChecks` | string[] | Extra review checks |
| `stack.line` | string | One-line stack description |
| `stack.formatter` | `{command, glob}` | Formatter invocation |
| `tiers.T0` … `tiers.T3` | `{paths: string[], budget: int, reviewModel: string}` | Risk tier by path (D17); per-tier budget and review model (D18) |
| `changelog.file` | string path | Assembled changelog (D21) |
| `changelog.fragmentsDir` | string path | Per-PR fragment directory (D21) |

## Hooks (all Node, exec form, stdlib only)

Registration shape for every hook:

    {"type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/hooks/<name>.js"]}

Behaviour contract: fail open on malformed payloads; pass deny JSON through
byte-for-byte; never depend on npm packages.

- **PreToolUse Bash dispatcher**: reads a declarative guard manifest
  `{name, match: regex on lowercased command, script}` and runs matching
  guards. Generic guards:
  - `pr-create`: `gh pr create` must be `--draft`
  - `worktree-commit`: deny commit when the branch is checked out in another worktree
  - `git-refspec`: deny bare local-branch refspec pushes
  - `csv-parse`: deny naive `awk -F,` / `cut -d,` on `.csv`
  - `merge-gate`: deny merge without a fresh human-merge marker
    `.git/claude-human-merge-ok` and squash; also registered directly on
    `mcp__github__merge_pull_request`
  - `user-level-write`: deny Bash `cp`/`tee`/`>`/`>>` into `~/.claude`, and Edit|Write there
  - `ci-owned-command`: deny `commands.ciOwned`
  - `slow-command`: background reminder for `commands.slow`
  - `delegation`: reminder for Bash write commands outside `delegation.inlineAllow`
- **Stop git-check**: block on uncommitted or unpushed work.
- **Rules injector** (D7): PostToolUse Bash; matches paths in the command
  against `.claude/rules/*.md` `paths:` globs; injects each rule once per
  session as `additionalContext`.
- **Telemetry** (D10): logs Skill invocations, Agent spawns, guard denies to
  `${CLAUDE_PLUGIN_DATA}/telemetry.jsonl`.
- **Session-context injector**: SessionStart; prints paths/caps/budget/modes
  from `taskFiles.*`; prints one line if `node --version` < 20.

Shared libs: `hooks/lib/{config,segment-split,glob}.js`. Tests: recorded
payloads (Linux AND Windows-shaped `cwd`/paths) under `hooks/tests/`, run by
`hooks/tests/run.js`.

## Agents (U4)

implementer, bug-fixer, test-writer, reviewer, doc-updater, explorer. Each:

- Tool-call budget default in the definition; the prompt may override. Reserve
  the last 3 calls. At cap: stop and emit a progress report.
- `memory: project`.
- `### LEARNING` return block: `{agent, date, branch, mistake: <slug|none>}`
  plus `MISTAKE:` / `LESSON:` lines.
- Read discipline: grep, then ranged read. Never rely on a hook to stop you.
- Subagent Git Contract: confirm `git branch --show-current` matches the stated
  branch before the first commit; STOP on mismatch; report branch, SHAs, and
  `git log --oneline <base>..HEAD`.

## Skills (U5)

- `dispatch`: routing table from `agents.*`
- `brainstorm`
- `review` (`full|security`)
- `session-wrap-up` (with a demotion step of equal standing to promotion)
- `audit`
- `bootstrap`: writes `.claude/forge.json`, `forge.md`, the CLAUDE.md
  framework block, `.claude/rules/`, `.gitattributes`, permissions
- `audit-framework`: validators for index/body sync, CLAUDE.md framework-block
  drift, stale-precondition grep, forge.json vs schema, zero-use telemetry,
  changelog fragment shape (D21), changed files falling through every tier (D17)

## Tiered process (addendum D17–D23, design notes)

- **Tier resolution**: `git diff --name-only <base>...HEAD` matched against
  `tiers.<T>.paths`; highest tier wins; no match means T2. Dispatch reads the
  tier to pick budget, review model, and the gate chain (D18).
- **Merge policy** (D19): T0 uses GitHub auto-merge with required checks and
  an owner notification; the merge-gate hook allows it only when the resolved
  tier is T0. T1–T3 need the human "merge" marker. The CLAUDE.md framework
  block states the T0 exception.
- **Status checks** (D20, U3/U5): CI posts a `forge validators` check run
  (schema, index contract, fragments, framework-block drift) and a
  `reviewer clean` commit status when the reviewer agent returns no blocking
  findings. Branch protection on main requires these plus CI; no required
  approvals.
- **Changelog close-out** (D21): session-wrap-up or the merge pipeline reads
  `changelog.fragmentsDir`, groups fragments by section, prepends a dated
  header to `changelog.file`, deletes the fragments, commits.
- **Pipeline** (D22): one script/workflow, implement → review → fix →
  re-review → changelog close-out → merge-base refresh, returning a readiness
  report: tier, what changed, what verified it, risks.
- **Measure first** (D23): telemetry adds tokens-per-unit and
  review-findings-per-unit; skill evals via `claude plugin eval`; audit
  lists mechanisms with no measured effect for the owner to prune.

## Phase 0 — blocking smoke test

Throwaway plugin `plugins/smoke/`: one skill printing a marker, one agent whose
definition contains the literal `FORGE-MARKER-7f3a`, one exec-form Node
PreToolUse Bash hook appending a line to `${CLAUDE_PLUGIN_DATA}/smoke.log`,
one PostToolUse Bash hook returning `additionalContext` with a distinctive
sentence, one SubagentStop hook dumping stdin to
`${CLAUDE_PLUGIN_DATA}/subagentstop.json`. Listed in the marketplace, enabled
via this repo's `.claude/settings.json` `enabledPlugins`.

Rows:
- A: Linux dev box terminal (owner)
- B: WSL2 on the Windows box (owner)
- C: cloud session started from the Android app (owner starts; checks run inside)
- D: Remote Control from the Android app to the VPS (owner)

Checks:
1. Installs from the private marketplace
2. `/smoke:<skill>` listed
3. Agent dispatchable; marker comes back verbatim
4. Exec-form Node hook fires (log grows)
5. PostToolUse-on-Bash `additionalContext` visible to the model next turn
6. `enabledPlugins` in project settings loads the plugin in a CLOUD session with no manual install
7. Survives restart
8. SubagentStop payload captured: field names; is the last assistant text present
9. Subagent rules-file auto-load: a subagent Reads a file matching a `paths:` rule and reports whether the rule text appeared
10. Native agent memory: where the file is written; what is injected next run
11. `${CLAUDE_PLUGIN_DATA}` writable and stable across restart (record the resolved path)

Results live in `docs/phase0-results.md`. If check 6 fails in cloud, the
fallback is the vendored copy described in `decisions.md`.
