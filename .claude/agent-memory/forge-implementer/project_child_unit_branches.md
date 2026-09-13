---
name: project-child-unit-branches
description: claude-forge uses stacked integration branches for units — a unit branch's PR targets the parent unit branch, not main.
metadata:
  type: project
---

This repo (`claude-forge`, the forge plugin's own source repo) builds each
plan unit (U1, U2, U3, ...) on its own branch, branched off the *previous*
unit's integration branch (e.g. `claude/u3-status-checks` off
`claude/units`, itself already the target of an open PR into `main`), not
off `main` directly.

**Why:** the owner wants each unit reviewable/mergeable independently while
still landing as one coherent stack into `main` — child units merge into
the parent integration branch, which merges to `main` once, per the
precedent set in commit `2c8f38d`.

**How to apply:** before opening a PR for a dispatched unit branch, check
the dispatch prompt's stated parent branch (not just `main`) and target the
PR there. Always confirm the actual branch name with `git branch
--show-current` before the first commit (Subagent Git Contract) — these
branch names are dispatch-specific and change every unit.
