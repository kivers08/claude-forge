# Adopting and operating the `forge` plugin

How a project takes on `forge` and runs the day-to-day pipeline. Written for a
mid-size TypeScript/Node service, but nothing here is stack-specific — `forge`
carries no company identifiers or stack lines (D1) and installs on any repo.

This is the operator's manual. The design rationale lives in `docs/decisions.md`
(D1–D27); this document cites those numbers rather than restating them. Known
gaps are called out honestly at the end.

---

## 1. What forge gives you

A coordinator session (you, plus Claude) that dispatches **six worker agents** —
`implementer`, `bug-fixer`, `test-writer`, `reviewer`, `doc-updater`,
`explorer` — through a disciplined loop: **implement → review → fix → changelog
→ merge**. The discipline is enforced two ways:

- **Guards** — Node PreToolUse/PostToolUse hooks that block classes of mistake
  before they happen (merging without a human decision, writing to `~/.claude`,
  opening a non-draft PR).
- **Status checks** — CI jobs that re-check the same things deterministically,
  plus one advisory model review.

The plugin is Node-only, zero npm dependencies, Node ≥ 20 (D11).

---

## 2. Bootstrap (once per project)

Run `/forge:bootstrap`. It scaffolds a project's thin layer:

- **`.claude/forge.json`** — strict JSON, validated against
  `plugins/forge/schema/forge.schema.json` (D12). Top-level keys today:
  `version`, `taskFiles`, `git`, `commands`, `readDiscipline`, `delegation`,
  `agents`, `stack`, `tiers`, `changelog`.
- **A sibling `forge.md`** explaining each key.
- **The CLAUDE.md framework block** — a marker-delimited region
  (`<!-- forge:framework-block:start -->` … `:end -->`) holding the coordinator
  rules. `/forge:audit-framework` later diffs that region against the plugin's
  canonical copy (`${CLAUDE_PLUGIN_ROOT}/templates/CLAUDE.md.framework-block`,
  D5) to catch drift.
- Starter `.claude/rules/`, `.gitattributes` (LF, D13), and any permissions the
  project needs.

**What you edit by hand after bootstrap:** the `tiers.*.paths` globs (§4), the
`stack` line, and any `agents.<agent>` overrides (budget, review model).

---

## 3. The daily loop

| Step | Skill | What it does |
|---|---|---|
| Settle a design question | `/forge:brainstorm` | Names the fork, records the decision in `taskFiles.decisionsLog`. Use *before* building anything with an unsettled schema/API. |
| Route a unit of work | `/forge:dispatch` | Picks the right worker agent, branch, tier, budget, and review model. |
| Review a diff | `/forge:review` | Runs the `reviewer` agent (full or security mode). |
| Run the whole pipeline | `/forge:pipeline` | implement → review → fix (≤2 rounds) → changelog close-out → merge-base refresh → readiness report. Coordinator-followed, **not** an automated script (D22). |
| Close the session | `/forge:session-wrap-up` | Promotes genuinely new lessons, demotes stale ones, refreshes open items, checks line caps. |
| Health checks | `/forge:audit`, `/forge:audit-framework` | Project-health and framework-contract audits respectively. |

Each **unit of work** is one branch off the integration branch and one PR
targeting it. Implement → review locally → fix → *only then* push and open the
PR, so CI runs once per unit, not once per commit.

---

## 4. Tiers (D17/D18)

`.claude/forge.json`'s `tiers.T0`–`tiers.T3` map path globs to a risk tier:

| Tier | Meaning | Typical gate chain |
|---|---|---|
| T0 | docs, changelog fragments, comment-only edits | validators + one reviewer pass |
| T1 | framework/config (`.claude/**`, hooks, workflows) | full review, cautious |
| T2 | **default** — app code (a path matching no tier is T2) | full review |
| T3 | high-risk (e.g. `src/payments/**`) | full review + extra checks |

Resolution is **per path, then the maximum across paths** — a PR touching one
doc plus one unclassified source file is T2, never T0. The resolver
(`plugins/forge/hooks/lib/tier.js`) is shared by every consumer so they cannot
disagree.

---

## 5. Merge policy (D19, as revised 2026-09-13)

**The merge-gate hook has no tier exception.** Every merge the agent runs into
the base branch (`git.baseBranch`, default `main`) requires a human marker:

```
touch .git/claude-human-merge-ok      # valid 15 minutes from its mtime
```

Merging a *unit* branch into an *integration* branch is not gated — only merges
whose destination is the real base branch are. The gate also requires a squash
merge (`git.squashOnly`, default true).

**T0 auto-merge is a CI job, not a hook exception.** `scripts/t0-auto-merge.js`
enables GitHub's own auto-merge for a T0 PR once required checks pass, and
posts an owner-mention comment so it is never silent. It resolves both its
config and its decision code from the *base ref* (a PR cannot declare itself
T0), verifies the base branch actually has required checks first, and revokes
its own grant if a later push escalates the tier. **The plugin ships no such
job** — it is a reference implementation in this repo; an adopting project
installs its own copy, and until it does, T0 PRs merge exactly like T1–T3.

Why the split: deciding "may this merge skip the marker?" by parsing `gh`'s
flag grammar in the hook proved bypassable five different ways. Removing the
exception took flag-parsing out of the security path entirely. The hook gates
the *agent's own* `gh pr merge`; the CI job never passes through the hook.

---

## 6. Status checks (D20)

CI posts three things on a PR:

- **`forge validators`** — deterministic, no model. Manifest/frontmatter
  validation + changelog-fragment shape. **Blocks** on any problem.
- **`reviewer clean`** — dispatches the `reviewer` agent headlessly and posts a
  commit status. **The verdict is advisory** (see below); only its
  *deterministic mechanics* block.
- **`t0-auto-merge`** — the T0 fast-path job (§5), if installed.

### What `reviewer clean` does and does not guarantee

The reviewer's finding count is **not reproducible run-to-run** — it surfaces a
different subset of a large candidate set each time. A required check that
cannot be driven green by fixing what it reports is not a gate. So the findings
**inform** (posted in the status description, full report in the job log) and
the **mechanics gate**: the check fails only on reproducible faults —

- the reviewer did not demonstrably read the diff (an unguessable-token ack),
- the diff body was truncated (the reviewer never saw the whole change),
- a git fault, or an unreadable base-ref system prompt,
- the PR touches the reviewer's **own instruction surface**.

That last one is a fail-closed gate: a PR editing `CLAUDE.md`/`AGENTS.md`,
`.claude/settings*.json`, `.claude/forge.json`, `.claude/rules/`,
`.claude/hooks/`, `.claude/{skills,agents,commands}/`, or the configured
`taskFiles.lessons` file cannot self-certify — it needs a human. This exists
because the reviewer child loads those as instructions; a PR that rewrites them
could make the reviewer lie about itself.

Treat a green `reviewer clean` as a *cooperative-author second opinion*, not an
enforcing boundary against an adversarial one. `forge validators` (fully
deterministic) is the enforcing check.

---

## 7. Changelog (D21)

Each PR adds one `changelog.d/<slug>.md` fragment:

```
section: Added | Changed | Fixed | Removed | Docs | Security
- one bullet per change, present tense
```

`scripts/changelog-closeout.js` assembles fragments into a dated `CHANGELOG.md`
header at release and deletes them. It is crash-safe (staging + atomic rename),
contains its configured paths to the repo, and refuses symlinked fragments.
Run on demand, not in CI.

---

## 8. Telemetry (D10/D23)

Two event types append to `${CLAUDE_PLUGIN_DATA}/telemetry.jsonl`:
`invocation` (every Skill/Agent/guard-deny, PreToolUse) and `unit_complete`
(SubagentStop — output volume and, for reviewer dispatches, parsed finding
counts). `/forge:audit-framework` lists zero-use mechanisms over N sessions so
you can retire them. Nothing is fabricated: when a value isn't in the payload
it's recorded as null.

---

## 9. Memory today (D4/D6/D15)

- **Per-agent memory** — each worker declares `memory: project` and writes
  committed markdown under `.claude/agent-memory/<plugin>-<agent>/`. This is
  role-scoped: a reviewer lesson does not surface to the implementer.
- **Index Contract (D6)** — grep-only files (lessons, todo, archives) carry a
  `## Index` section; each anchor appears once in the body. The SessionStart
  injector emits a per-file slice (`index` / `open-items` / `head-N`) within
  `taskFiles.injectionBudget`.
- **`### LEARNING` blocks (D15)** — an agent→coordinator report convention.

`memory-v2.md` (the sibling plan) proposes evolving this without losing the
per-agent scoping or the git-visibility that make it safe.

---

## 10. Known gaps (as of 2026-09-13)

- **D27 — quote bypass: FIXED (2026-09-24).** `gh "pr" merge 7 --squash` no
  longer skips the merge gate. Fixed at both layers: the tokenizer
  (`plugins/forge/hooks/lib/segment-split.js`) stops treating a cosmetically
  quoted bare word as data, and the PreToolUse dispatcher (`pre-bash.js`)
  prefilter now also matches against the quote-stripped token stream so the
  guard is actually dispatched. See `docs/decisions.md` D27.
  **Still open (its own unit):** a raw API merge
  (`gh api -X PUT …/pulls/N/merge`) is a different command shape `merge-gate`'s
  `match` (`gh pr merge|git merge`) never sees. Fix on *effect* (anything that
  lands a commit on the base branch), not command shape. On a private repo the
  local guard is the *only* enforcement, so this vector still matters.
- **D20 blocker** — branch protection and rulesets are unavailable on a private
  repo under a free org plan (both endpoints 403). So D20's checks can be
  *posted* but never *required*, and the T0 CI fast path stays dormant (it
  declines when the base branch has no required checks). Resolving it is an
  owner decision: transfer the repo to an account with GitHub Pro, upgrade the
  org, or accept local-only enforcement.
- **D19 follow-up** — the T0 CI job runs from a workflow file that comes from
  the PR's merge ref, so a PR can append a step to it. Interim mitigation:
  the job ships `contents: read` + `pull-requests: read`, so an appended step
  inherits no write scope. The real fix is a dedicated `pull_request_target`
  workflow (needs no PR checkout), tracked as its own unit.
- **Reviewer agent-memory — CLOSED by memory-v2 D28.4** (see `docs/decisions.md`
  D20). `.claude/agent-memory/forge-reviewer/` is read by the reviewer as
  prior lessons, so it is an instruction surface; `reviewer-clean-check.js`
  now reads it from the base ref (`readReviewerMemoryFromBase`), the same way
  the system prompt already was, and hands it to the child as an explicit
  file alongside the diff. `.claude/agent-memory/` (every agent's) is also
  now in `SELF_REVIEW_FORBIDDEN_PATTERNS`, so a PR touching it fails the
  check and needs a human rather than passing quietly.
