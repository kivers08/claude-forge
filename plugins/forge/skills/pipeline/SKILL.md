---
name: pipeline
description: Run one sized unit of work through implement → review → fix loop → changelog close-out → merge-base refresh, ending in a readiness report (tier, what changed, what verified it, risks). Use once `dispatch` has sized a unit and you're ready to take it from first implementation to "ready to merge."
---

# pipeline

Formalizes the sequence a coordinator already runs by hand for every unit of
work, so it happens the same way every time instead of from memory. This is
**a process for the coordinator to follow, not an automated script** — there
is no single command that runs the six steps below unattended. Each step
still requires the coordinator to dispatch the right agent, read its actual
result, and decide whether to proceed before moving to the next step. If a
step's dispatched agent comes back with something unexpected (scope
questions, a fork it wants a human decision on, a budget exhaustion), that is
this skill telling you to stop and resolve it, not something to skip past to
keep the pipeline moving.

This skill assumes `dispatch`'s sizing (agent choice, tier, budget, review
model, branch) is already done — see `dispatch/SKILL.md`. Do not re-derive
that sizing here; read it in from the unit's dispatch prompt.

## Non-goal: this is not headless/unattended

Nothing here spawns a Claude agent from a plain script. Only the coordinator
(this interactive session) can dispatch a worker agent; the one narrower
exception in this repo is `scripts/reviewer-clean-check.js`, which invokes
`claude -p` once, non-interactively, in CI, for a single review pass with no
fix loop and no human in it. Building a CI-headless variant of this entire
pipeline — implement, fix, and re-review all running unattended — is a
materially different and much higher-risk undertaking (it removes human
attendance from exactly the steps, implement and fix, where an agent commits
code) and is explicitly **out of scope** for this skill. If that's ever
wanted, it would mean reproducing `reviewer-clean-check.js`'s `claude -p`
pattern per step, as its own separate, deliberately-scoped unit — not an
extension of this one.

## 1. Implement

Dispatch the sized unit to the agent `dispatch/SKILL.md` selected (usually
`implementer`) with the branch, base branch, budget, and scope it already
resolved. Read the agent's `### LEARNING` block and full report before
proceeding — a report that says "left undone: X" or flags a fork is a stop
condition, not something to carry forward silently into review.

## 2. Review

Dispatch `forge:reviewer` against the resulting diff, stating the base
branch explicitly (the same base named in the implement dispatch — never let
the reviewer guess it). Use `full` mode by default, per `review/SKILL.md`,
unless the unit's tier or the coordinator has a specific reason to run
`security` mode instead.

Read the reviewer's required closing summary line verbatim: "N bugs, N
security issues, N convention violations, N suggestions."

## 3. Fix loop

**Fix-worthy = bugs + security issues + convention violations** (bare
suggestions never force a round on their own — the reviewer agent frames
"suggestions" as its lowest severity).

Note the division of labour with CI. As of the D20 revision,
`scripts/reviewer-clean-check.js` no longer blocks on the finding count: its
verdict is advisory (it posts `success` with the counts in the description
and fails only on reproducible mechanics faults — a missed ack/token, a
truncated diff, a git fault, a touched instruction surface). So CI will not
catch a unit shipped with open bugs — **this human-run pipeline is where
finding-driven quality is actually enforced**, not a mirror of a CI gate.
Don't call a unit clean with open bugs/security/convention findings just
because CI will go green regardless.

If the fix-worthy count is 0 after step 2, skip straight to step 4.

If it is nonzero:

1. Dispatch `forge:bug-fixer` with the reviewer's specific findings (not a
   paraphrase — quote them), scoped to just those findings.
2. Re-dispatch `forge:reviewer` against the updated diff (same base branch).
3. Repeat from (1) if still nonzero.

**Cap at 2 fix-and-re-review rounds.** If the review after the second fix
round is still not clean (a third consecutive non-clean review), stop the
loop and report to the human instead of dispatching a third fix — a
findings count that isn't converging after two rounds is a signal something
about the unit's scope or the fixer's approach is wrong, not a signal to try
again with the same recipe.

## 4. Changelog close-out

Once review is clean (0 fix-worthy), add a `changelog.d/<unit>.md` fragment
yourself (the coordinator's own job — `scripts/changelog-closeout.js`'s own
doc comment names this as "on-demand only... not wired into CI," i.e. a step
a human or coordinating agent runs deliberately, not something a worker
agent or a script does for you). Match the shape in `changelog.d/README.md`:

```
section: Added | Changed | Fixed | Removed | Docs | Security
- one bullet per change, present tense, no PR number needed
```

Validate it before proceeding:

```
node scripts/validate-changelog.js
```

Do not run `scripts/changelog-closeout.js` itself as part of this step —
that assembles *all* pending fragments into `CHANGELOG.md` and deletes them,
which is a separate, later action (typically a release step), not something
this skill triggers per-unit.

## 5. Merge-base refresh

Before opening (or right before merging) the unit's sub-PR, check whether
its base branch has moved since the unit branch was created:

```
git fetch origin <base>
git log --oneline <unit-branch>..origin/<base>
git diff --name-only <unit-branch>...origin/<base>
```

Compare that changed-path list against the unit's own
`git diff <base>...HEAD --name-only`. If there's file overlap — or any
other concrete reason to expect a conflict — say so explicitly as a risk the
coordinator must not skip past silently. **This skill does not itself
attempt a rebase or merge** — resolving a real conflict is a decision for
the coordinator or the human, not something to paper over inside this check.
If the base hasn't moved, or moved with no overlap, say that explicitly too
(a silent "checked" with no stated result is not verification).

## 6. Readiness report

Once steps 1–5 are done, produce this report yourself — no script emits it
for you. Four required fields:

- **tier** — resolved via `plugins/forge/hooks/lib/tier.js`'s
  `resolveTier(config, changedPaths)` against the unit's actual final diff
  (`git diff <base>...HEAD --name-only`), not the tier assumed at dispatch
  time. If the two disagree (the diff ended up touching higher-tier paths
  than expected), say so — that's a risk, not a detail to quietly correct.
- **what changed** — a short prose summary plus
  `git diff <base>...HEAD --stat`.
- **what verified it** — which checks/tests ran and passed, the final
  review round's fix-worthy count (must be 0 to reach this step), and how many
  fix-and-re-review rounds it took (0, 1, or 2).
- **risks** — anything flagged in step 5, any non-blocking reviewer
  suggestions left unaddressed, and anything the implementer's (or
  bug-fixer's) own report flagged as uncertain or left undone.

Example shape:

```
## Readiness report: u9-example-unit

**Tier:** T2 (app code) — resolveTier matched `src/**` against tiers.T2;
matches the tier assumed at dispatch time.

**What changed:** Adds retry-with-backoff to the webhook sender so a
transient 5xx from the downstream doesn't drop the event.

  src/webhooks/sender.js       | 41 ++++++++++++++++++++++++++++++-----
  src/webhooks/sender.test.js  | 58 +++++++++++++++++++++++++++++++++++++++++
  2 files changed, 92 insertions(+), 7 deletions(-)

**What verified it:** implementer's own scoped test run (sender.test.js,
6/6 passing); reviewer full-mode pass, clean after 1 fix round (round 1:
1 bug, 0 security, 1 convention, 2 suggestions; round 2: 0 bugs, 0
security, 0 convention, 1 suggestion).

**Risks:** base branch (`claude/units`) has moved 3 commits since this
unit branched, but none touch `src/webhooks/**` — no expected conflict.
One non-blocking reviewer suggestion left unaddressed: extract the retry
delay into a named constant (cosmetic, not required). Implementer's report
flagged the backoff cap (30s) as a guess, not sourced from a stated
requirement — worth confirming with whoever owns the webhook SLA before
merge.
```

## Hard constraints

- Never call a unit "clean" with open bugs, security issues, or convention
  violations. Since the D20 revision, CI's `reviewer clean` is advisory and
  will go green regardless of the finding count, so this pipeline — not CI —
  is what actually holds that line. A green CI status is not evidence the
  findings were addressed.
- Never skip step 5 because the diff "looks small" — the check itself is
  cheap; the point is to never let coordination-branch drift surface for the
  first time as a merge conflict during an actual merge attempt.
- Never let the fix loop run a third round silently — two rounds is the cap,
  full stop, report to the human.
- Never fabricate a readiness-report field from memory of the diff instead
  of the actual commands in steps 1–5 — every field above must trace back to
  something read or run during this pipeline run, not a summary of what was
  probably true.
