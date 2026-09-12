---
name: review
description: "Review a diff via the reviewer agent, in one of two modes: full (correctness/security/convention/coverage, the default) or security (security issues only, deeper pass). Use before merging, or on demand for a second opinion on a diff."
argument-hint: "[full|security] [PR number | branch | path]"
---

# review

Dispatches the `reviewer` agent (or, in `security` mode, the same agent
scoped to only its security checklist) against a diff, then relays findings.
This skill never edits files and never posts to GitHub itself — same
constraint as the `reviewer` agent it dispatches.

## Modes

- **`full`** (default, no argument or `full`): the reviewer's complete
  checklist — correctness bugs, security issues, convention violations, test
  coverage gaps, simplification suggestions — in that priority order.
- **`security`**: dispatch the reviewer agent with an explicit instruction to
  run *only* its security checklist item, at higher scrutiny (check every
  changed trust boundary, not just the obviously suspicious ones). Skip
  convention/coverage/simplification entirely in this mode — it's a focused
  pass, not a lighter full review.

## Target resolution

The second argument (or the current branch if omitted) determines the diff:
- A PR number: fetch that PR's base and head, review `base...head`.
- A branch name: review `git.baseBranch...  <branch>`.
- A path: narrow the review to that path within the current branch's diff
  against `git.baseBranch`.
- Nothing given: review the current branch against `git.baseBranch`.

State the resolved base/head explicitly in the reviewer's dispatch prompt —
per the reviewer agent's own contract, it must never assume a base branch.

## Process

1. Resolve the target (above) and the mode.
2. Dispatch the `reviewer` agent with: the resolved base/head, the mode, and
   the resolved budget/review-model from `dispatch`'s tier resolution if this
   review is part of a larger unit (a standalone on-demand review may just
   use the agent's own default).
3. Relay the reviewer's findings to the human or the calling context exactly
   as the agent reported them — do not editorialize on severity or drop
   findings.
4. If the calling context is a merge pipeline that posts inline PR comments,
   that posting happens outside this skill (per the reviewer agent's own
   "never posts to GitHub" constraint) — say explicitly whether findings were
   posted or just relayed.

## Hard constraints

- Never skip straight to "looks good" without dispatching the reviewer agent
  — this skill's value is the structured pass, not a summary from memory of
  the diff.
- `security` mode must not silently fall back to a full review; if the
  reviewer agent's checklist can't be scoped down for some target, say so
  rather than running the full pass unlabeled.
