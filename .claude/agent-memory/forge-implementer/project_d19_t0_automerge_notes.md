---
name: project-d19-t0-automerge-notes
description: Findings from implementing D17/D19 (tier resolver + merge-gate T0 auto-merge exception, unit u6) that aren't obvious from re-reading the code alone.
metadata:
  type: project
---

Two non-obvious findings from implementing the D19 T0 auto-merge carve-out
(`plugins/forge/hooks/lib/tier.js`, `scripts/t0-auto-merge.js`,
`plugins/forge/hooks/guards/merge-gate.js`'s T0+`--auto` exception):

1. **No owner-mention/PR-comment convention exists anywhere in this repo**
   as of 2026-09-12 (checked `docs/`, `scripts/`, `.github/workflows/`, and
   actual PR history via `gh pr list`/`gh pr view --json comments` across
   PRs #1-#12 — none post an `@handle` mention). `scripts/t0-auto-merge.js`
   uses `kivers08` (from `gh api user`, matching the git author email
   `kivers08@gmail.com` used in this repo's own commits) as the default
   owner handle to `cc @` in the T0 auto-merge notification comment, with a
   `FORGE_OWNER_HANDLE` env/repo-variable override. **Why:** the dispatch
   prompt asked to reuse an existing convention; none was found, so this
   was a documented best-guess rather than a reuse. **How to apply:** if a
   later unit adds a real owner-notification convention (e.g. a
   `forge.json` key, a CODEOWNERS-driven mention), update
   `scripts/t0-auto-merge.js`'s default and drop this ad hoc guess.

2. **The GitHub MCP server's `merge_pull_request` tool has no auto-merge
   input.** Its shape (confirmed via `pre-merge-mcp.js`'s own existing
   `merge_method`/`pullNumber` field reads, and by reasoning about the
   tool's behavior — it performs an immediate merge, not an
   enable-and-wait) has no equivalent to `gh pr merge --auto`. Because the
   D19 T0 exception's safety property depends specifically on GitHub
   *waiting* for required checks before merging, `pre-merge-mcp.js`
   deliberately has **no** T0 carve-out — it stays fully gated at every
   tier. **Why:** an immediate merge (direct `gh pr merge`, or
   `merge_pull_request`) has no wait to stand in for the human-merge
   marker. **How to apply:** if the GitHub MCP server ever adds a genuine
   "enable auto-merge" tool/field, that new call is the one to gate this
   exception on — not `merge_pull_request`.

See [[project_child_unit_branches]] for the branch/PR structure this unit
(`claude/u6-merge-gate-t0`, PR into `claude/units`) was dispatched under.
