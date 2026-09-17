section: Security
- `plugins/forge/hooks/memory-redact.js` now resolves its target path with
  `path.resolve` before testing whether it is under `.claude/agent-memory/`,
  and tests containment with an anchored `path.relative` (mirroring
  `guards/user-level-write.js` / `guards/worktree-commit.js`) instead of a
  regex/prefix test on the raw, possibly-relative path. A `..`-bearing or
  mixed-separator path could previously either evade the scrub on a real
  agent-memory write or be mismatched against a path outside the tree.
- The same containment test now also covers `.claude/agent-memory-local/`
  (native's gitignored local-scope memory), which the hook previously left
  unscrubbed entirely.
- A 512 KB size guard: a file larger than that is left untouched rather than
  read/scrubbed/rewritten. This hook runs synchronously inside the session,
  and the `secret-assignment` pattern's backtracking cost grows with input
  size, so an unbounded file could otherwise stall a turn.

section: Fixed
- `lib/redact.js`'s `secret-assignment` pattern captured a surrounding quote
  but the replacement dropped it, turning `FOO_SECRET="abc"` into the
  malformed `FOO_SECRET=[REDACTED:secret-assignment]"` (orphaned trailing
  quote). The quote is now preserved on both sides of the placeholder.

section: Added
- Direct unit tests for `lib/redact.js`'s `scrubSecrets` in the new
  `plugins/forge/hooks/tests/redact.test.js` (AWS/GitHub/PEM/Slack/API-key/
  Bearer/secret-assignment, including the quote-preservation case), wired
  into `ci.yml` alongside the existing `memory-redact.test.js` step.
- `memory-redact.test.js` gained cases for a local-scope
  `agent-memory-local` write, a `..`-traversal path that resolves outside
  agent-memory (must not be scrubbed), the mirror case of a harmless `..`
  detour that still resolves inside agent-memory (must still be scrubbed),
  and a file over the new size guard (must be left untouched).
