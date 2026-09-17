'use strict';
// Shared secret/PII scrubber for forge hooks. Node stdlib only (D11): no npm
// deps, no Date.now()/Math.random() (this module calls neither).
//
// Salvaged from the memory-v2 custom storage engine's record library (the
// hardened redaction patterns that engine's write path used), which has
// since been superseded by native Claude Code subagent memory. Those same
// patterns now back memory-redact.js's on-disk rescrub of native
// `.claude/agent-memory/**` and `.claude/agent-memory-local/**` writes
// (D28.4).
//
// A stdlib pattern safety-net, NOT a guarantee. A bare high-entropy string with
// no recognizable prefix/shape can slip through.
//
// Each entry: { kind, re } where `re` has a capture group for any leading
// keyword/prefix we want to preserve so the record stays readable.
const REDACTION_PATTERNS = [
  // PEM private key blocks (RSA/EC/OPENSSH/DSA/PGP/ENCRYPTED/generic).
  // `ENCRYPTED ` is included: an encrypted private key is still a private key
  // and no later token pattern would catch the block.
  {
    // The body is a BOUNDED lazy [\s\S]{0,8192}? (a PEM key body is a few KB;
    // 8 KB is ample) rather than an unbounded [\s\S]*? — an unterminated
    // BEGIN line would otherwise force the engine to scan all the way to EOF
    // once per BEGIN before giving up, which is O(k*n) in file size.
    // The real PGP private key header/footer is
    // `-----BEGIN PGP PRIVATE KEY BLOCK-----` / `-----END PGP PRIVATE KEY
    // BLOCK-----` (a ` BLOCK` suffix the other key types don't have) — so
    // `(?: BLOCK)?` is allowed on BOTH ends, not just assumed absent, or the
    // `PGP ` alternative never actually matches a real pasted GPG key.
    kind: 'pem',
    re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----[\s\S]{0,8192}?-----END (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g,
    replace: () => '[REDACTED:pem]',
  },
  // AWS access key id.
  {
    kind: 'aws-access-key',
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replace: () => '[REDACTED:aws-access-key]',
  },
  // GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_, github_pat_).
  {
    kind: 'github-token',
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g,
    replace: () => '[REDACTED:github-token]',
  },
  // Slack tokens.
  {
    kind: 'slack-token',
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    replace: () => '[REDACTED:slack-token]',
  },
  // OpenAI / Anthropic-style keys (sk-..., sk-ant-...).
  {
    kind: 'api-key',
    re: /\b(?:sk|pk)-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g,
    replace: () => '[REDACTED:api-key]',
  },
  // Bearer tokens in an Authorization value.
  {
    kind: 'bearer-token',
    re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g,
    replace: () => 'Bearer [REDACTED:bearer-token]',
  },
  // *_SECRET= / *_TOKEN= / *_KEY= / *_PASSWORD= assignment forms. The keyword
  // (the LHS + `=`) is preserved so the record still reads sensibly; only the
  // value is scrubbed. The surrounding quote (group 3, if any) is captured so
  // it can be re-emitted on BOTH sides of the placeholder — dropping it would
  // turn `FOO_SECRET="abc"` into the malformed `FOO_SECRET=[REDACTED:...]"`
  // (an orphaned trailing quote) instead of `FOO_SECRET="[REDACTED:...]"`.
  // The quote class is `["']?` (not `"?`) so a SINGLE-quoted value like
  // `FOO_SECRET='abc123'` is matched too, not just double-quoted/unquoted.
  {
    // The `(?!\[REDACTED:)` guard stops this (broad) pattern from re-redacting a
    // value an EARLIER, more-specific pattern already replaced (e.g. a
    // GITHUB_TOKEN= that became `[REDACTED:github-token]`). Without it the
    // specific kind label is lost and `redactions` double-counts one secret.
    //
    // The keyword itself (group 1) is matched loosely by the regex — any case,
    // with or without a separator — and then validated in `replace` below:
    // it must look like an IDENTIFIER (env var / config key), not an ordinary
    // English word, or this pattern corrupts prose in a memory note (this
    // store is prose) like "the secret: sauce" or "password: is a bad idea".
    // A keyword qualifies only if it is ALL-CAPS (GITHUB_TOKEN, SECRET) or
    // contains a `_`/`-` separator (aws_secret, api-key) — a bare lowercase
    // word with no separator (secret, token, password) does not. But an
    // identifier-shaped keyword can STILL be prose — "github-token: rotated
    // last week" and "aws_secret_key: rotate it manually" both have a
    // hyphen/underscore keyword yet an ordinary English-sentence value — so
    // the identifier check alone is not sufficient either; see `replace`
    // below for the combined rule.
    // The keyword's surrounding classes are BOUNDED ({0,64}, not the
    // unbounded *) — an unbounded class-star around an 8-way alternation is
    // vulnerable to catastrophic backtracking (O(n^2)) on adversarial input
    // like a long run of `[A-Za-z0-9_-]` characters containing no match. A
    // real env/config key is well under 64 chars, so this bound never affects
    // a legitimate match.
    kind: 'secret-assignment',
    re: /\b([A-Za-z0-9_-]{0,64}(?:SECRET|TOKEN|PASSWORD|APIKEY|API[_-]KEY|ACCESS[_-]KEY|PRIVATE[_-]KEY)[A-Za-z0-9_-]{0,64})(\s*[=:]\s*)(["']?)(?!\[REDACTED:)([^\s"']{6,})\3/gi,
    replace: (m, kw, sep, quote, val) => {
      // Neither the keyword shape NOR the separator shape alone is enough to
      // tell a credential from prose. Three signals combine:
      //   - looksLikeIdentifier: the keyword reads like an env var/config key
      //     (ALL-CAPS or `_`/`-` separated) rather than a plain English word.
      //   - isTightAssignment: a bare `=` with NO surrounding whitespace
      //     (`secret=VALUE`) is never English prose regardless of keyword
      //     case — prose never writes "secret=" mid-sentence — so this alone
      //     is sufficient even for a bare lowercase keyword like `secret` or
      //     `token`.
      //   - looksLikeProseValue: an unquoted, whitespace-separated value that
      //     is nothing but lowercase letters (`token: rotated`) reads as an
      //     English sentence, not a credential — a real secret value nearly
      //     always contains a digit, mixed case, or punctuation. A QUOTED
      //     value is always treated as a credential (quoting a plain English
      //     word as a "value" is not something ordinary prose does).
      const looksLikeIdentifier = kw === kw.toUpperCase() || /[_-]/.test(kw);
      const isTightAssignment = sep.trim() === '=' && !/\s/.test(sep);
      const looksLikeProseValue = !quote && /\s/.test(sep) && /^[a-z]+$/.test(val);
      const shouldRedact = (looksLikeIdentifier || isTightAssignment) && !looksLikeProseValue;
      return shouldRedact ? `${kw}${sep}${quote}[REDACTED:secret-assignment]${quote}` : m;
    },
  },
];

// Returns { text, redactions } — redactions is a list of { kind } counted so a
// caller can log/telemeter what was scrubbed without re-exposing the secret.
function scrubSecrets(input) {
  let text = String(input == null ? '' : input);
  const redactions = [];
  for (const p of REDACTION_PATTERNS) {
    text = text.replace(p.re, (...args) => {
      const out = p.replace(...args);
      // Only record a redaction when the replacement actually changed the
      // text: secret-assignment's prose-decline path returns the match
      // unchanged (see the identifier check above), and counting that as a
      // redaction would over-count telemetry and corrupt D10 audit counts
      // for text that was never touched.
      if (out !== args[0]) redactions.push({ kind: p.kind });
      return out;
    });
  }
  return { text, redactions };
}

module.exports = {
  REDACTION_PATTERNS,
  scrubSecrets,
};
