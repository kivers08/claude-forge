---
id: fb08a39a-dc99-4f3c-bc5c-59880f4b74b9
type: note
scope: implementer
tier: semantic
importance: 0.5
created: "2026-09-17T01:17:45.812Z"
lastUsed: null
uses: 0
source: authored
supersedes: null
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

**Sibling units are invisible to each other until merged.** Two units
branched from the same parent (e.g. `claude/u6-merge-gate-t0` and
`claude/u8-pipeline`, both off `claude/units`) do not see each other's
commits — a dispatch prompt can say a prior unit's file "already exists in
the branch history you're based on" when it actually only exists on an
unmerged sibling branch. Confirmed this on U8 (pipeline skill): the dispatch
prompt claimed `plugins/forge/hooks/lib/tier.js` (D17) was already built and
present, but `find`/`ls` in the u8 worktree came up empty — it only existed
on `claude/u6-merge-gate-t0` (commit `f2d132a`), not yet merged into
`claude/units`. Fix: use `git log --all --oneline | grep <topic>` and `git
branch -a --contains <sha>` to locate the real commit before concluding the
dispatch prompt is wrong; if it's confirmed to live only on an unmerged
sibling, it's still safe to reference it in prose/docs (it will exist once
units land), but don't assume the file is readable in your own worktree —
use `git show <sha>:<path>` to inspect it instead.
