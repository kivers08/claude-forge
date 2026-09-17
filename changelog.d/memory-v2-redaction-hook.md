section: Security
- `plugins/forge/hooks/memory-redact.js` now resolves its target path with
  `path.resolve` before testing whether it is under `.claude/agent-memory/`,
  and tests containment with an anchored `path.relative` — a resolve-then-
  compare approach as in `guards/worktree-commit.js`, tightened further to
  the anchored `path.relative` check described here — instead of a
  regex/prefix test on the raw, possibly-relative path. A `..`-bearing or
  mixed-separator path could previously either evade the scrub on a real
  agent-memory write or be mismatched against a path outside the tree.
- The same containment test now also covers `.claude/agent-memory-local/`
  (native's gitignored local-scope memory), which the hook previously left
  unscrubbed entirely.
- The containment check is re-run against the path's REAL, symlink-resolved
  target (`fs.realpathSync`), not just its `..`-collapsed form: a symlink
  planted inside `.claude/agent-memory/**` pointing at a file outside it
  previously passed containment on its own path while
  `readFileSync`/`writeFileSync` silently followed the link and
  read/rewrote the external target. `realpathSync` failures fail open (skip,
  no crash).
- An oversize file (over the 64 KB scrub cap) previously returned silently,
  meaning a file with secrets could be committed unscrubbed with no record
  of it. The hook now emits a `memory_redact_skipped` telemetry record
  (kind/byte-count/repo-relative path only, never content) before skipping.
- `lib/redact.js`'s `secret-assignment` and `pem` patterns had unbounded
  greedy/lazy quantifiers around their keyword/body groups, which is
  vulnerable to catastrophic (O(n^2)) backtracking on adversarial input (e.g.
  a long run of `[A-Za-z0-9_-]` characters with no match). Both are now
  bounded (`{0,64}` on the keyword surroundings, `{0,8192}?` on the PEM body)
  so the worst-case cost of a non-match no longer scales with input size.
  This bound, not the size guard below, is the actual ReDoS fix.
- A 64 KB size guard (previously 512 KB, sized to the old unbounded-regex
  worst case): a file larger than that is left untouched rather than
  read/scrubbed/rewritten. This hook runs synchronously inside the session;
  the guard is now defense-in-depth on top of the bounded-quantifier fix
  above, sized to real agent-memory note sizes rather than to a worst case
  that no longer applies.

section: Fixed
- `lib/redact.js`'s `pem` pattern required `PRIVATE KEY-----` immediately
  after the `PGP ` prefix, but a real PGP private key block's header/footer
  is `-----BEGIN PGP PRIVATE KEY BLOCK-----` / `-----END PGP PRIVATE KEY
  BLOCK-----` (with a trailing ` BLOCK`), so the `PGP ` alternative never
  actually matched and a pasted GPG key was left unredacted. An optional
  `(?: BLOCK)?` suffix is now allowed on both the BEGIN and END lines.
- `lib/redact.js`'s `secret-assignment` decline rule was both too aggressive
  and too lenient. Too aggressive: an identifier-shaped keyword
  (`github-token`, `aws_secret_key`) followed by an ordinary English-sentence
  value (`github-token: rotated last week`) was still redacted, destroying
  unrecoverable prose in a prose store. Too lenient: a bare lowercase keyword
  in a tight `secret=value`/`token=value` assignment (no separator
  whitespace) — a real leak shape — was declined outright. The decision now
  combines keyword shape, separator tightness, and value shape: a tight `=`
  assignment is redacted regardless of keyword case (prose never writes
  `secret=` with no surrounding whitespace), and an identifier-shaped keyword
  is redacted UNLESS its value is unquoted, whitespace-separated, and purely
  lowercase letters (which reads as prose, not a credential).
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
  `password: is a bad idea` — was silently corrupted into a redaction (see
  the combined keyword/separator/value rule above for the fix's final
  shape).
- `scrubSecrets` recorded a redaction unconditionally inside each pattern's
  `replace` callback, even when the callback declined to change the text
  (the `secret-assignment` prose-decline path returns the match unchanged).
  Prose like `the secret: sauceology tastes great` was recording a phantom
  `secret-assignment` redaction, over-counting the D10 audit telemetry. A
  redaction is now recorded only when the replacement actually changed the
  matched text.

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
  a symlink inside agent-memory pointing outside it (must not be
  read/rewritten), an oversize file (must emit `memory_redact_skipped`
  telemetry), and a file over the new size guard (must be left untouched).

section: Removed
- `lib/redact.js` no longer exports `scrubValueDeep` or `REDACTION_CAVEAT`:
  neither had a caller (the only consumer, `memory-redact.js`, uses
  `scrubSecrets` on raw file text). Dropped rather than kept "for later" —
  recoverable from git history when the adoption-migration unit that would
  need structured-value scrubbing is actually built.
