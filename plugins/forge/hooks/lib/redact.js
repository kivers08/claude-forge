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
// no recognizable prefix/shape can slip through — this is documented honestly
// wherever a redacted record is written (see REDACTION_CAVEAT).
//
// Each entry: { kind, re } where `re` has a capture group for any leading
// keyword/prefix we want to preserve so the record stays readable.
const REDACTION_PATTERNS = [
  // PEM private key blocks (RSA/EC/OPENSSH/DSA/PGP/ENCRYPTED/generic).
  // `ENCRYPTED ` is included: an encrypted private key is still a private key
  // and no later token pattern would catch the block.
  {
    kind: 'pem',
    re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----/g,
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
    // word with no separator (secret, token, password) does not.
    kind: 'secret-assignment',
    re: /\b([A-Za-z0-9_-]*(?:SECRET|TOKEN|PASSWORD|APIKEY|API[_-]KEY|ACCESS[_-]KEY|PRIVATE[_-]KEY)[A-Za-z0-9_-]*)(\s*[=:]\s*)(["']?)(?!\[REDACTED:)([^\s"']{6,})\3/gi,
    replace: (m, kw, sep, quote) => {
      const looksLikeIdentifier = kw === kw.toUpperCase() || /[_-]/.test(kw);
      return looksLikeIdentifier ? `${kw}${sep}${quote}[REDACTED:secret-assignment]${quote}` : m;
    },
  },
];

// Unused by memory-redact.js today (it only needs scrubSecrets + the
// patterns) — retained for the not-yet-built adoption-migration unit
// (D28.4 unit 4), which will need to scrub structured/frontmatter values and
// surface this caveat to whatever it writes.
const REDACTION_CAVEAT =
  'Redaction is a stdlib pattern safety-net, not a guarantee: a bare ' +
  'high-entropy string with no recognizable prefix can slip through.';

// Returns { text, redactions } — redactions is a list of { kind } counted so a
// caller can log/telemeter what was scrubbed without re-exposing the secret.
function scrubSecrets(input) {
  let text = String(input == null ? '' : input);
  const redactions = [];
  for (const p of REDACTION_PATTERNS) {
    text = text.replace(p.re, (...args) => {
      redactions.push({ kind: p.kind });
      return p.replace(...args);
    });
  }
  return { text, redactions };
}

// Recursively scrub every string in a JSON-ish value, pushing each redaction
// into `redactions`. Kept alongside scrubSecrets for callers that need to
// scrub a parsed structure (e.g. frontmatter) rather than raw file text —
// see the D28.4 unit 4 note on REDACTION_CAVEAT above; no current caller.
function scrubValueDeep(value, redactions) {
  if (typeof value === 'string') {
    const r = scrubSecrets(value);
    for (const red of r.redactions) redactions.push(red);
    return r.text;
  }
  if (Array.isArray(value)) return value.map((v) => scrubValueDeep(v, redactions));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = scrubValueDeep(value[k], redactions);
    return out;
  }
  return value;
}

module.exports = {
  REDACTION_PATTERNS, REDACTION_CAVEAT,
  scrubSecrets, scrubValueDeep,
};
