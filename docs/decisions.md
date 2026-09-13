# forge — settled decisions

This file is the source of truth for design decisions behind the `forge` plugin.
Decisions are the owner's unless tagged otherwise. Change a decision here first,
then change code. Never put a model identifier, company name, or stack line in
the plugin itself (D1).

## Working style (binding on anyone building this repo)

- Concise and direct; no preamble. Flag ambiguous decisions explicitly.
- Don't guess API or field names. Verify against docs and say what was verified.
- If an approach has a real downside, say so plainly.
- Substantial reference content goes in a saved file, not a chat wall.
- Delegate implementation to subagents in the background where the environment
  supports it; keep the main context for coordination.
- PRs are always opened as DRAFT; always squash merge; never merge to `main`
  without the owner's explicit "merge" command.

## Decisions

### D1 — Audience
Private, owner-only, used across the owner's own projects, any stack. The plugin
carries no company identifiers and no stack lines; it must install cleanly on an
unrelated project. A version string plus `CHANGELOG.md`; no semver ceremony.

### D2 — Packaging
This repo is both the plugin (`plugins/forge/`) and the marketplace
(`.claude-plugin/marketplace.json`, local-path source). There is no template
repo: `/forge:bootstrap` scaffolds a project's thin layer.

### D3 — Naming
Plugin name `forge`. Skills are invoked as `/forge:<skill>`. Project config lives
at `.claude/forge.json`.

### D4 — Memory
Plugin agents declare `memory: project` (native persistent agent memory), AND
projects may keep hand-rolled memory spokes for one release. Compare later.

### D5 — No agent-rules registry
Worker rules live once, in the plugin's agent definitions. Coordinator rules
live in a marker-delimited "framework block" that `/forge:bootstrap` writes into
the project's `CLAUDE.md`; `/forge:audit-framework` diffs that block against the
plugin's canonical copy.

### D6 — Index Contract
Every grep-only file (lessons, todo, archives) carries a `## Index` section with
lines of the form:

    - [YYYY-MM-DD] <one-line summary> → grep "<anchor>"

Each anchor appears verbatim exactly once in the body. Session-start injection of
the todo file stays item-level (open checkboxes) as a documented exception. The
injector supports modes per file: `index` | `open-items` | `head-N`.

### D7 — Rules delivery (UNVERIFIED until Phase 0 check 5)
A plugin PostToolUse-on-Bash "rules injector" parses file paths out of
`tool_input.command`, matches them against the project's `.claude/rules/*.md`
`paths:` globs, and injects each matching rule once per session as
`additionalContext`.

### D8 — Follow-up work continues the same agent
Follow-up work on the same unit continues the same agent (SendMessage / resume).
Fresh dispatch only for a genuinely new scope. Caveat: resuming replays the
transcript, roughly double token cost per round. Accepted.

### D10 — Demotion
A telemetry hook logs every Skill invocation, Agent spawn, and guard deny to
`${CLAUDE_PLUGIN_DATA}/telemetry.jsonl`. `/forge:audit-framework` lists
zero-use mechanisms over N sessions and stale-precondition comments
("until X", "because Y doesn't", "kept because"). The owner retires them.

### D11 — Hook runtime: Node only
Every hook is a `.js` file registered in EXEC FORM:

    {"type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/hooks/<name>.js"]}

Zero npm dependencies (Node stdlib only). Node >= 20 is a documented
prerequisite. Node is NOT bundled with Claude Code (verified in docs).

### D12 — Config
`.claude/forge.json`, strict JSON, validated against
`plugins/forge/schema/forge.schema.json`. Bootstrap writes it plus a sibling
`forge.md` explaining each key.

### D13 — Platforms
Linux (VPS, dev box, cloud containers) and Windows 11 (mostly WSL2, VS Code,
claude.ai; native Windows rare). No macOS support, ever. Android app usage means
cloud sessions and Remote Control must be first-class. Native Windows without
Git for Windows uses the PowerShell tool, which Bash-command guards never see:
documented limitation, not solved. Enforce `.gitattributes` `* text=auto eol=lf`.

### D15 — `### LEARNING` block
Stays a report convention (agent to coordinator). SubagentStop auto-filing is an
experiment only, because its payload is undocumented.

### D16 — Sequencing
Phase 0 smoke test BLOCKS the real build (Phase 2, U2 onward). U1 (skeleton) may
proceed in parallel with Phase 0.

(D9 and D14 were folded into other decisions during brainstorming and have no
separate entry.)

## Verified Claude Code facts

From the official docs as of 2026-09-09. "Not documented" means unknown, not
false. Re-verify before relying on anything marked unverified.

1. Hook stdin payload fields: `session_id`, `prompt_id`, `transcript_path`,
   `cwd`, `permission_mode`, `hook_event_name`. Bash: `tool_input.command`.
   Edit/Write: `tool_input.file_path`. Path substitutions in hook commands:
   `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`.
   A plugin hook CAN read project files (use payload `cwd`; the
   `CLAUDE_PROJECT_DIR` env var works in practice but is not documented).
2. A plugin ships: `skills/`, `commands/`, `agents/`, `hooks/hooks.json`,
   `.mcp.json`, `.lsp.json`, `monitors/`, `bin/`, `.claude-plugin/plugin.json`.
   Plugin `settings.json` is LIMITED to `agent` and `subagentStatusLine`. A
   plugin CANNOT ship `permissions`, `.claude/rules/*.md`, or `CLAUDE.md`.
   Those are project-side; bootstrap writes them.
3. Path-scoped rules (`paths:` frontmatter) trigger on the Read tool
   (documented). Edit/Write/Bash/Grep: not documented. Subagent applicability:
   not documented.
4. `SubagentStop` exists. Input is now documented (`agent_id`, `agent_type`,
   `agent_transcript_path`, `last_assistant_message`, `stop_hook_active`) and
   Phase 0 C0 observed it plus `scratchpad_dir`, `effort`, `prompt_id`. Output
   and blocking: undocumented. See `phase0-results.md`.
5. (reserved)
6. Marketplace = repo with `.claude-plugin/marketplace.json`. Plugin entries:
   name, source (GitHub, git URL, npm, archive, command, or local path),
   optional `version`. Auto-update is OFF by default for third-party
   marketplaces. Private GitHub repos work via git credentials.
7. Plugin skills are namespaced `/plugin-name:skill-name` and never collide with
   project skills. A project agent with the same name OVERRIDES the plugin agent
   (sanctioned customization path). Hook ordering across scopes: not fully
   documented.
8. Plugin agent frontmatter supports: name, description, model, tools,
   disallowedTools, memory (scopes user/project/local; project writes to
   `.claude/agent-memory/<plugin>-<name>/` for plugin agents, observed in
   Phase 0 C0; the docs say `<name>` alone; committable), skills, maxTurns, background,
   effort, isolation. NOT supported in plugin agents: permissionMode,
   mcpServers, hooks.
9. `claude plugin validate [--strict]` (CI-capable); `claude plugin eval`
   (early access); `/skill-doctor`.
10. Cloud sessions: project `.claude/agents/` load; project `enabledPlugins` in
    `.claude/settings.json` is honored, BUT external-source plugins do not
    auto-install in cloud (v2.1.195+); per-machine installs unproven in cloud.
    Observed: a cloud session on another of the owner's repos loaded project
    hooks/skills/agents but had zero plugins enabled. Cloud loading is the top
    risk and the Phase 0 gate.
11. Skill frontmatter: name, description, disable-model-invocation,
    user-invocable, allowed-tools, disallowed-tools, context: fork, agent,
    paths, arguments.
12. Settings precedence: managed > CLI > `.claude/settings.local.json` >
    `.claude/settings.json` > `~/.claude/settings.json`.
13. Auto memory (which `memory:` depends on) was OFF by default in the Phase 0
    cloud container with no setting or env var present;
    `CLAUDE_CODE_DISABLE_AUTO_MEMORY=0` turned it on. Owner rows must confirm.
14. Hook command exec form (`args` array) is documented: no shell, placeholders
    substituted into each arg, and `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT`,
    `CLAUDE_PLUGIN_DATA` are exported as env vars to the spawned process.

## Fallback if cloud loading fails (Phase 0 check 6)

A git-vendored copy of `plugins/forge` at `.claude/vendor/forge/` in each
project, with hooks registered by `${CLAUDE_PROJECT_DIR}` path instead of
`${CLAUDE_PLUGIN_ROOT}`.

## Addendum 2026-09-11: risk tiers

Owner-decided, delivered to the build session mid-U1. Owner goals verbatim:
"less of my time per change, tier the process by risk, get it right before it
hits main".

### D17 — Risk tiers by path
Highest tier wins when a PR spans tiers.
- **T0** docs/bookkeeping: `tasks/`, `docs/`, changelog fragments, comment-only edits
- **T1** framework/config: `.claude/`, hooks, workflows, settings
- **T2** app code: `src/`, `tests/`, `scripts/`
- **T3** money/auth/data/deploy: payments, webhook signatures, migrations, deploy config

`forge.json` gains `tiers`. Shape chosen for the schema (one object per tier,
all keys optional, unknown keys rejected):

    "tiers": {
      "T0": { "paths": ["docs/**", "tasks/**", "changelog.d/**"], "budget": 30, "reviewModel": "..." },
      "T1": { "paths": [".claude/**", ".github/**"], "budget": 60, "reviewModel": "..." },
      "T2": { "paths": ["src/**", "tests/**", "scripts/**"], "budget": 120, "reviewModel": "..." },
      "T3": { "paths": ["src/payments/**", "migrations/**"], "budget": 120, "reviewModel": "..." }
    }

`paths` are globs matched against repo-relative paths of changed files.
A file matching no tier is T2 by default (app code is the safe assumption);
`/forge:audit-framework` warns when changed files fall through.

### D18 — Gates per tier
- T0: validators + one reviewer pass per batch
- T1: hook harness + hook tests + reviewer + CI
- T2: full chain (implementer → test-writer → reviewer → CI)
- T3: T2 + security review + an owner-facing diff summary

The tier also sets the agent budget and the review model. In the schema these
are the per-tier `budget` and `reviewModel` overrides above. Precedence:
prompt override > `tiers.<T>.budget` > `agents.<name>.budget` > agent
definition default. Same order for the review model with
`agents.reviewer.model` in the third slot.

### D19 — Merge by tier
T0 PRs use GitHub auto-merge once required checks are green, with a
notification to the owner. T1–T3 keep the explicit human "merge" plus the
merge-gate hook. The bootstrap-written CLAUDE.md framework block must state
this T0 exception explicitly.

**REVISED 2026-09-13: the merge-gate hook carries no T0 exception.** The
original design let the hook skip the human marker when it parsed `--auto`
out of the command and the diff resolved to T0. Deciding that by hand-parsing
`gh`'s flag grammar proved wrong five times running — quoted tokens, value
positions (`--body --auto`), the `-A` shorthand, and pflag clustered
shorthands (`-sA --auto`) each let a DIRECT merge reach the exception, and
each fix closed one spelling while missing another. The exception was removed
rather than patched a sixth time.

Nothing is lost by that. The hook gates the *agent's* own `gh pr merge`;
the T0 fast path is performed by the CI job (`scripts/t0-auto-merge.js`),
which never passes through the hook and resolves both its config and its
decision code from the base ref. The agent never needed the carve-out to get
T0 PRs merged. The gate is now unconditional — marker required at every tier
— which removes flag parsing from the security path entirely.

Caveat on "unconditional": the gate is unconditional *by tier*, but D27's
tokenizer bypass (quoting one word of the command) still slips past the guard
entirely, marker and all. That is a pre-existing bug rather than a sanctioned
path, and the framework-block template now says so rather than promising
adopting projects a guarantee the code does not yet enforce.

**Follow-up unit (recorded 2026-09-13, not built): move the T0 job to its own
workflow on `pull_request_target`.** Two review findings converge on it. (S1)
Extracting the decision *code* from the base ref is necessary but not
sufficient while the *workflow file* that runs it still comes from the PR's
merge ref — a PR can add a step to the job that judges it. (S2) Listening for
`ready_for_review` on the shared `ci.yml` trigger, with the other jobs skipped
on that event, replaced their real check runs with `skipped` ones; branch
protection counts skipped as success, so a draft that went red could be
marked ready and auto-merge on that same event. That change was reverted.
`pull_request_target` runs the workflow from the base ref with a write token,
and the T0 job never needs to check out PR code (config, decision code and
`gh` calls only), which is the one shape where that trigger is safe — and it
can carry `types: [opened, synchronize, reopened, ready_for_review]` without
touching the validation jobs. Until then, a T0 PR marked ready with no further
push stays on the explicit-merge path.

If a hook-side exception is ever wanted again it needs a different mechanism
than command-line parsing (a proper pflag-grammar parser as its own tested
module, or a signal that does not come from the command text at all), and its
own unit.

### D20 — Branch protection = required status checks
`main` is protected by required STATUS CHECKS (CI, `forge validators`,
`reviewer clean`), not required approvals: the coordinator never approves.
Design note for U3/U5: the plugin (via CI) posts a `forge validators` check
run and a `reviewer clean` commit status.

Built in U3 (`.github/workflows/ci.yml`, `scripts/validate-changelog.js`,
`scripts/reviewer-clean-check.js`):
- **`forge validators`** — a required (fails the build on any problem),
  fully deterministic job. Runs `validate-plugins.js --strict` (manifest and
  frontmatter shape) plus a new dependency-free changelog fragment shape
  check (D21): every `changelog.d/*.md` except `README.md` must parse as one
  or more `section: <name>` blocks each followed by at least one `- `
  bullet.
- **`reviewer clean`** — dispatches the `forge:reviewer` agent headlessly
  (`claude -p`, fed `agents/reviewer.md`'s own body as the system prompt,
  same "full" mode the `review` skill defaults to) against the PR's diff,
  then posts a commit status (`success`/`failure`) via the GitHub statuses
  API. Blocking = bugs + security issues + convention violations from the
  reviewer's own closing summary line; bare suggestions don't block.
- **`forge validators` always runs; only `reviewer clean` skips off
  self-hosted.** Both jobs reuse the exact `CORP_RUNNER` repo/org variable
  gate `ci.yml`'s `validate` job already uses, but only to pick *which*
  runner they land on. `forge validators` is pure, dependency-free Node
  with no external CLI/auth requirement, so it always runs both of its
  checks regardless of runner — gating a required, deterministic check
  behind runner availability would let it silently no-op on the exact
  fallback path it exists to still catch problems on. `reviewer clean` is
  the one that conditionally skips: its script checks `CORP_RUNNER` itself
  before dispatching the reviewer agent, and posts a `success` status with
  a `skipped: <reason>` description instead of failing the build when it's
  off the self-hosted runner. This mirrors the existing "claude plugin
  validate --strict" CI step's `continue-on-error` fallback.
- **No new secret.** `reviewer clean` authenticates by reusing whatever
  `claude` login already exists on the self-hosted runner (the owner's
  Claude subscription, not an API key) and posts to GitHub with the
  workflow's own `GITHUB_TOKEN`. If `claude` isn't on PATH or isn't
  authenticated, it skips gracefully the same way as the CORP_RUNNER-unset
  case — no `ANTHROPIC_API_KEY` or other secret was added.
- **Not yet enforced.** No branch-protection ruleset was created or changed
  by this work — it only builds the mechanism a future ruleset would
  require. Turning required-status-check enforcement on for `main` is a
  separate, explicit owner decision (see the open `d26-branch-protection`
  draft).
- **The verdict does not block; the mechanics do.** (Decided 2026-09-13,
  after this unit's own PR.) The finding count is not reproducible run to
  run: on PR #15 it ROSE — 1 bug/2 security to 2 bugs/3 security — after
  every finding from the previous run had been fixed. The reviewer surfaces
  a different subset of a large candidate set each time rather than
  converging. A required check that cannot be driven green by fixing what it
  reports is not a gate. So `reviewer-clean-check.js` posts `success` with
  the counts in the description and the full report in the job log, whatever
  the findings — and posts `failure` only for the reproducible faults: the
  reviewer did not demonstrably read the diff (ack/token gate), the diff was
  truncated, a git call failed, the base-ref system prompt was unreadable, or
  the PR touches the reviewer's own instruction surface. Those are the half
  of this check that can be an enforcing boundary, and they are the half that
  is required under D26. Everything below still applies to the verdict half.
- **Advisory, not a security boundary.** `reviewer clean`'s verdict is
  model-authored text derived from untrusted PR diff content, then parsed
  for pass/fail — so the diff itself is prompt-injection surface against
  the gate (e.g. a planted line matching the required summary/ack format).
  The hardening in U9 (`--restricted`, `--tools Read,Glob,Grep`,
  `--strict-mcp-config`, a minimal child env, the diff/system-prompt both
  read from trusted refs, and the unguessable-token `diff-resolved:` ack)
  correctly limits *side effects* and catches an accidentally-skipped
  review — it does not make the verdict itself trustworthy against a PR
  deliberately trying to defeat it. Treat `reviewer clean` as a second
  opinion against cooperative authors, not the enforcing check against an
  adversarial one; `forge validators` (fully deterministic, no model in the
  loop) is the check that fills that role.
- **Enumerating the child's instruction inputs.** The system prompt is read
  from the base ref, but the child still runs rooted in the PR-controlled
  worktree (`cwd`/`--add-dir`). The criterion for this list is: loaded
  automatically by the CLI **or** read on the base-ref prompt's own
  instruction. Both halves matter, and the second is the larger one —
  - auto-loaded: `CLAUDE.md` (project memory; also `CLAUDE.local.md`, and
    non-root copies, which load when files in that subtree are read) and
    `.claude/settings.json` / `.claude/settings.local.json` (project
    settings still apply under `--restricted` — that is why `--settings
    '{"disableAllHooks":true}'` was needed at all; `--settings` layers on
    top rather than replacing);
  - read on instruction: `.claude/forge.json`, which supplies
    `agents.reviewer.extraChecks` — free text appended straight to the
    reviewer's checklist, i.e. instruction injection through a config key —
    plus `agents.reviewer.budget` and `readDiscipline.*`, where a budget of
    `1` neuters the review with no prose at all; `.claude/rules/*.md`, cited
    as authoritative conventions; and the configured `taskFiles.lessons`
    file, which the prompt greps and quotes.
  - listed pending verification: `.claude/skills/`, `.claude/agents/` and
    `.claude/commands/`, which the CLI discovers from the project directory.
    It is plausible their metadata is suppressed when the `Skill`/`Task`
    tools aren't granted (this child gets `Read,Glob,Grep` only), but that is
    unverified against the pinned runner CLI. The repo has none of them, so
    listing them blocks nothing; re-check and record the answer rather than
    leaving it ambiguous. `plugins/forge/skills/` is deliberately excluded —
    per `.claude/settings.json` the plugin loads from the marketplace clone
    of this repo, not the PR worktree, so a PR editing it cannot reach its
    own review.

  A PR touching any of these is writing trusted-position instructions for
  the agent judging it, so `reviewer-clean-check.js` fails closed and defers
  to a human. Deterministic path check (patterns, not exact strings), not a
  model judgment; the lessons path is resolved from the **base** ref's
  config so that moving the key cannot sidestep the check.
  `plugins/forge/agents/reviewer.md` is deliberately not in that list — it
  is already read from the base ref, so editing it cannot influence its own
  review, and listing it would block every legitimate change to the reviewer
  agent for no added protection. Residual: anything else the CLI may load
  from the tree in a future version, or a future edit to the reviewer prompt
  that tells the child to read something new — re-check this enumeration
  when the pinned `claude` version moves or `reviewer.md` grows a new input.
  One known gap is deliberate: `.claude/agent-memory/forge-reviewer/` is read
  by the reviewer as prior lessons and so meets the criterion, but gating it
  would block every legitimate memory update (the D19 unit contains one).
  Closing it needs a design decision — probably reading agent memory from the
  base ref, the way the system prompt already is — not a pattern-list entry.
  Also note the paths are compared as raw bytes: `changedInstructionSurfaces`
  runs `git diff` with `-z` and `core.quotePath=false` because git's default
  quoting of non-ASCII paths would wrap them in `"` and defeat every anchor
  in the pattern list. For the same reason, the base ref's config is read
  with a `git ls-tree` probe first: `git show` exits non-zero both when the
  file is absent and when git itself fails, and collapsing those would
  silently disable the lessons half of the gate on any git hiccup. Note
  `git cat-file -e` is NOT usable for this — a path missing from the tree
  exits 128, the same as a real fault.

**BLOCKER (verified 2026-09-13): branch protection is not available on this
repository.** `GET /repos/kewi-development/claude-forge/branches/<b>/protection`
and `GET /repos/.../rulesets` both return **403 "Upgrade to GitHub Pro or make
this repository public"** — the repo is private in a free org. So required
status checks cannot be enforced here at all, which undercuts a premise used
in three places:

- D20's required checks (`forge validators`, `reviewer clean`) can be *posted*
  but never *required*, so nothing stops a merge that ignores them.
- D19's T0 carve-out justifies skipping the human-merge marker with "GitHub
  waits for required status checks in place of it". With no protection
  available that argument cannot hold, so `t0-auto-merge.js` verifies the
  precondition and stays dormant — correct, but it means the T0 fast path is
  currently dead code on this repo.
- The merge-gate hook (`plugins/forge/hooks/guards/merge-gate.js`) is
  therefore the *only* actual enforcement, and it is local: it gates the
  agent's own Bash calls, not a merge made in the GitHub UI or by another
  client.

Resolving this is the owner's call and needs one of: make the repo public,
upgrade the org's plan, or accept local-only enforcement and stop describing
these checks as required. Until then, treat "required status check" language
in D19/D20/D26 as aspirational — this section included.

### D21 — Changelog fragments
Each PR adds `changelog.d/<slug>.md` containing a section name and a bullet.
The close-out step assembles fragments into the dated header at merge and
deletes them. Schema gains `changelog.file` and `changelog.fragmentsDir`. The
audit-framework validator checks fragments are well-formed.

Built: `scripts/changelog-closeout.js` (dependency-free Node script). Parses
every fragment in `changelog.d/` (all `.md` files except `README.md`) using
the same fragment shape as `changelog.d/README.md` describes (`section:
<Name>` lines followed by `- bullet` lines, indented continuations allowed),
groups bullets by section name in first-encountered order across fragments
(processed in sorted filename order for determinism), and prepends a `##
YYYY-MM-DD` section — with a `### <section>` sub-header per section name
found, no fixed whitelist — directly under the `# Changelog` H1 in
`CHANGELOG.md`, above whatever content is already there. On success it
deletes the fragments it just assembled. It refuses to run (exit 1, no
changes made) when there are zero fragments to assemble (clean idempotent
no-op) or when any fragment fails shape validation, pointing at
`scripts/validate-changelog.js` for details rather than assembling malformed
input.

Hardened (2026-09-13, U11, after Copilot's review of PR #9 was verified
against the current tree): `changelog.fragmentsDir` and `changelog.file`
are contained both lexically and physically (`resolveInside` — `path.resolve`
plus a realpath check of the deepest existing ancestor, so a committed
symlink cannot point either outside the repo); a symlinked or irregular
fragment, a symlinked fragments directory, or a symlinked/non-regular
changelog target is a hard error; fragment listing uses `lstat`, not Dirent
type flags (which are all false on `DT_UNKNOWN` filesystems). Close-out is
crash-safe: fragments move into `changelog.d/.closeout-staging/` first, the
changelog is written via `CHANGELOG.md.tmp` created with `O_EXCL` and
renamed into place, staging is removed last; a run that finds staging
non-empty refuses (and, if a `PUBLISHED` marker is present, states that the
previous run's write did succeed); a failed publish restores fragments and
never deletes one it could not restore. Every refusal is an `error:` line,
exit 1. `scripts/tests/changelog.test.js` pins all of it.

This is on-demand only — invoked by a human or an agent explicitly running
it. It is not wired into CI, a git hook, or any automatic trigger; the full
sequence (implement → review → changelog close-out → merge) is formalized by
D22 below.

### D22 — Pipelines as code
implement → review → fix → re-review → changelog close-out → merge-base
refresh, returning a readiness report: tier, what changed, what verified it,
risks.

**Delivered scope (revised from the original design note):** built as the
`plugins/forge/skills/pipeline/SKILL.md` skill — a process the coordinator
follows step by step, dispatching `dispatch`/`review`/bug-fixer at each
stage and producing the readiness report themselves, not a script that runs
any of this unattended. This plugin has no mechanism for a plain script to
spawn a Claude agent inside an interactive session (only the coordinator
can), so a genuinely headless variant would need `reviewer-clean-check.js`'s
`claude -p` pattern applied to every stage, not just review — materially
higher-risk (no human attendance on implement/fix) and explicitly deferred
to its own future, separately-numbered unit, not part of D22 as delivered.

### D23 — Measure before adding
Telemetry (D10) plus tokens-per-unit and review-findings-per-unit; skill
evals; prune what shows no measured effect.

## Addendum 2026-09-11b: cloud loading and U2 sequencing

### D24 — Cloud plugin loading: environment setup script
Option 1 from `phase0-results.md` is chosen. Cloud environments run, before each
session:

    claude plugin marketplace add kewi-development/claude-forge
    claude plugin install forge@claude-forge

This is environment-side configuration, not repo content: no vendoring, no
duplicate copy of the plugin per project, and the plugin stays a single source
of truth. Requires the cloud environment's git credentials to reach the private
repo (the clone worked in the Phase 0 container).

Rejected and why:
- `CLAUDE_CODE_PLUGIN_SEED_DIR` image seeding: same shape, but goes stale unless
  the image is rebuilt on every forge release.
- Vendored `.claude/vendor/forge/`: works everywhere with no install step, but
  duplicates the plugin into every project and adds a sync step per release.
  Kept as the documented fallback if D24 fails on a real cloud row.
- SessionStart install hook: untested, and a plugin installed mid-session
  probably does not load its hooks or agents until restart.

Project `.claude/settings.json` keeps `extraKnownMarketplaces` and
`enabledPlugins`: the marketplace registration IS honored from project settings
(Phase 0 check 6), and persistent machines (rows A, B, D) still only need a
one-time `claude plugin install`.

### D25 — U2 proceeds in parallel with the remaining Phase 0 rows
D16 made Phase 0 block the real build. Narrow exception, owner-decided: the hook
unit (U2) does not depend on HOW the plugin is delivered to a session, only on
hook behaviour already proven by Phase 0 checks 4, 5 and 11 in row C0. U2 builds
now. Rows A–D still gate U3+ and still decide D4 (native memory off by default
in cloud) and D24.

### D26 — U4 proceeds; rows A/B still outstanding (owner override, now fully confirmed for row D)
2026-09-12: owner ran an additional cloud-environment verification beyond row
C's Android session and gave an explicit "continue building" for U4, with row
**D** (VPS via Remote Control) explicitly deferred to a later install/test
pass. This is NOT the same as rows **A** (Linux dev box terminal) or **B**
(WSL2) from the Phase 0 matrix — those remain unrun as of this decision. Owner
chose to proceed to U4 anyway; this is a partial, explicit override of D25's
gate, not a claim that A/B are satisfied. `phase0-results.md`'s matrix should
be corrected with the actual row this new cloud session corresponds to (or a
new row added) once that's confirmed.

**Row D complete except a literal restart, same day:** an already-open session
on the owner's dev VPS (Remote Control from the Android app) checked in.
`CLAUDE_CODE_REMOTE` was unset there, so `.claude/hooks/session-start.sh`'s
auto-install never fires on this machine (that variable is
Anthropic-cloud-specific, not set by Remote-Control-to-a-persistent-box) —
check 6 is n/a for row D, consistent with D24's "persistent machines only
need a one-time manual install" reasoning. Manual `claude plugin install` for
both plugins worked (check 1 PASS), but neither plugin's hooks/agents/skills
loaded into that already-running session afterward, confirming D24's original
mid-session-load concern for this specific path.

Checks 2–5 and 7–11 were then run via independent headless `claude -p`
subprocesses (the same method C0 used), since the live session can't restart
itself mid-conversation. All passed. See `phase0-results.md`'s "Row D partial
run" and "Row D agent-dispatch findings" notes for full detail, including a
real safety finding surfaced along the way: this VPS has
`permissions.defaultMode: "auto"` set globally in `~/.claude/settings.json`,
so a headless smoke-agent dispatch committed and pushed a stray commit to
`claude/units` entirely on its own initiative (nothing in the agent's
definition asked for this) — cleaned up with a follow-up commit, but the
underlying auto-approval setting is unchanged and is an owner decision, not a
forge issue.

**Row D fully confirmed, same day, by a literal restart:** later the same
day the owner opened a genuinely new interactive session on this same VPS
(this is that literal restart the checks above could only proxy). All of
checks 1–5 and 7–11 were reconfirmed directly — including the owner running
`/smoke:ping` themselves (check 2 is gated to explicit user invocation, not
model-triggerable) and getting the marker back exactly, and this session's
own SessionStart hook firing with a fresh marker as direct restart evidence
for check 7. `permissions.defaultMode: "auto"` is still set on this VPS,
unchanged. Row D is now fully confirmed for every check that applies to it
(6 remains n/a, per the `CLAUDE_CODE_REMOTE` reasoning above). Rows A and B
remain fully unrun. See `phase0-results.md`'s "Row D live-session
confirmation" note for full detail.

## Addendum 2026-09-12: pre-existing guard-tokenizer bypass found during D19 review

### D27 — `hasUnquotedSequence` can be bypassed by quoting one word (not yet fixed)
Discovered by the `forge:reviewer` agent while reviewing the D19 merge-gate
T0 carve-out (`claude/u6-merge-gate-t0`, PR into `claude/units`). Any guard
built on `plugins/forge/hooks/lib/segment-split.js`'s `hasUnquotedSequence`
(e.g. `merge-gate`, `pr-create`) can be bypassed by quoting a single word of
an otherwise-real command: `gh "pr" merge 7 --squash` runs identically to
`gh pr merge 7 --squash` in bash, but the tokenizer marks `pr` as quoted, so
the sequence match fails and the guard never fires — including the merge-gate
marker requirement. Confirmed empirically (not just reasoned about); pre-dates
D19 and every unit in this epic. Not introduced or worsened by D19; not fixed
by it either. Needs its own unit: distinguish "this whole segment is one
argument to another command" from "one word of a real command happens to be
quoted" in `segment-split.js`, then re-verify every guard that depends on
`hasUnquotedSequence`/`subcommandAfter`.
