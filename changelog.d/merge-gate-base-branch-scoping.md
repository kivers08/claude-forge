section: Fixed
- `merge-gate` now only requires the human `.git/claude-human-merge-ok`
  marker (and squash) when a merge's actual DESTINATION is `git.baseBranch`.
  Previously `gh pr merge` and the GitHub MCP merge were gated unconditionally
  regardless of target, which was stricter than the stated policy ("never
  merge to main without an explicit merge command") and blocked an
  integration-branch workflow where child units merge into an owner-chosen
  non-`main` branch. The destination is resolved via `gh pr view
  --json baseRefName`, best-effort: unresolvable (no `gh` on PATH, no
  network, unreadable payload) fails safe to "assume the base branch" (still
  gated). Local `git merge` needed no change — it was already scoped this way.
