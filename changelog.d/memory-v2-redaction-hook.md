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
- `secret-assignment`'s quote group only matched double-quotes or unquoted
  values (`("?)...\2`), so a SINGLE-quoted secret like
  `FOO_SECRET='abc123def456'` was never redacted at all. The quote class is
  now `["']?`, covering single-quoted, double-quoted, and unquoted forms.
- `secret-assignment`'s keyword side matched any English word containing
  "secret"/"token"/"password"/etc. followed by `:`/`=`, so ordinary prose in
  a memory note (this store is prose) — e.g. `the secret: sauce` or
  `password: is a bad idea` — was silently corrupted into a redaction. The
  keyword must now look like an identifier (env var / config key): either
  ALL-CAPS (`GITHUB_TOKEN`) or containing a `_`/`-` separator (`aws_secret`,
  `api-key`). A bare lowercase English word with no separator no longer
  matches.

section: Docs
- `memory-redact.js` now documents, next to its scope list, that user-scope
  memory (`~/.claude/agent-memory/`) is intentionally out of scope for
  redaction: forge's user-level-write guard already blocks writes under
  `~/.claude`, so this hook could never rewrite a file there, and user-scope
  memory is machine-local/personal rather than the committed/shared surface
  this hook protects. A recorded decision, not an oversight.

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
