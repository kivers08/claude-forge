'use strict';
// forge memory-v2 record library (D28, docs/plans/memory-v2.md unit 1).
//
// Node stdlib ONLY (D11): no npm deps. Pure library — it takes `now` and `id`
// from its caller so a hook can supply values safely. The plan (§3.2) is
// explicit that ids/timestamps must NOT come from Date.now()/Math.random()
// *inside a hook*; a hook is fingerprinted for determinism and non-determinism
// there is a smell. This module never calls Date.now() or Math.random(). It
// will call crypto.randomUUID() ONLY when a caller explicitly asks newId() for
// an id and supplies none — crypto.randomUUID() is called out as allowed in the
// dispatch. Callers inside hooks should still pass their own id/now.
// crypto.randomUUID() is also used internally by writeRecord for the
// TRANSIENT `.tmp-<uuid>` atomic-write filename (see writeRecord): that name
// never reaches a record's own bytes or its final on-disk filename, so it is
// determinism-neutral — it cannot make a hook's fingerprinted OUTPUT vary.
//
// Canonical store (D28.1, §3.1): committed markdown, one file per record, under
//   .claude/agent-memory/<plugin>-<agent>/
// Per-agent scope (D4) is load-bearing: a reviewer record must never be read as
// an implementer record. readScope() reads exactly one agent directory and
// never crosses into a sibling scope.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Schema (docs/plans/memory-v2.md §3.2)
// ---------------------------------------------------------------------------

// The type set: Anthropic's four native subject-types plus forge's `decision`
// extension (D28.3). Adding a type is cheap, removing one is not (§3.2), so it
// stays tight until a concrete need. Anything outside this set is invalid.
const TYPES = ['user', 'feedback', 'project', 'reference', 'decision'];

// Known agent scopes (§3.2). An unknown scope is not rejected by the parser
// (it fails open — see parseRecord), but writeRecord requires a caller-supplied
// scope and the frontmatter carries whatever is passed. This list is the set
// the recall pipeline (unit 3) will treat as first-class; kept here as the one
// authoritative copy.
const SCOPES = [
  'reviewer', 'implementer', 'bug-fixer', 'test-writer',
  'doc-updater', 'explorer', 'coordinator',
];

const TIERS = ['working', 'episodic', 'semantic'];
const SOURCES = ['authored', 'learning-block', 'ambient'];

// D28.3: a record is a strict superset of Claude Code's native memory format.
// `name`/`description` stay at the TOP level (the Anthropic fields); every
// forge operational/ranking field moves under a single `metadata:` block.
// Both orders are kept explicit so round-trips are stable and diffs stay
// minimal.
const TOP_LEVEL_ORDER = ['name', 'description'];
const METADATA_ORDER = [
  'type', 'scope', 'id', 'tier', 'importance',
  'created', 'lastUsed', 'uses', 'source', 'supersedes',
];

// ---------------------------------------------------------------------------
// Redaction scrubber (§4)
// ---------------------------------------------------------------------------
//
// A stdlib pattern safety-net, NOT a guarantee. A bare high-entropy string with
// no recognizable prefix/shape can slip through — this is documented honestly
// wherever a redacted record is written (see REDACTION_CAVEAT) and in the plan.
// The scrubber runs on every write path before bytes touch disk.
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
  // value is scrubbed.
  {
    // The `(?!\[REDACTED:)` guard stops this (broad) pattern from re-redacting a
    // value an EARLIER, more-specific pattern already replaced (e.g. a
    // GITHUB_TOKEN= that became `[REDACTED:github-token]`). Without it the
    // specific kind label is lost and `redactions` double-counts one secret.
    kind: 'secret-assignment',
    re: /\b([A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY)[A-Za-z0-9_]*\s*[=:]\s*)("?)(?!\[REDACTED:)([^\s"']{6,})\2/gi,
    replace: (m, kw) => `${kw}[REDACTED:secret-assignment]`,
  },
];

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

// ---------------------------------------------------------------------------
// Frontmatter parse / serialize
// ---------------------------------------------------------------------------
//
// A deliberately small YAML-ish subset: `key: value` lines between two `---`
// fences. No nested maps, no flow collections, no anchors. Records this library
// writes only ever use scalar fields (§3.2), so a full YAML parser (a dep,
// forbidden by D11) is unnecessary. Unknown keys are preserved verbatim in
// `extra` so the migration of pre-existing files (which carry name/description/
// metadata blocks) is lossless.

function parseScalar(raw) {
  const v = raw.trim();
  if (v === '') return '';
  if (v === 'null' || v === '~') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  // Quoted string: strip the quotes. For double-quoted values invert
  // serializeScalar's escaping (\\, \", \n, \r) so parse is a true inverse of
  // serialize; single-quoted values are taken literally. A single regex pass
  // over the full escape alphabet (rather than independent String#replace
  // calls per escape) is required so a literal backslash immediately
  // followed by an `n`/`r`/quote in the SOURCE text is never reinterpreted:
  // each match consumes exactly one backslash plus its one escaped char, left
  // to right, so a run like `\\n` (escaped backslash, then literal `n`) can
  // never be mis-read as `\n` (escaped newline).
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    return v.slice(1, -1).replace(/\\(["\\nr])/g, (_, c) => (
      c === 'n' ? '\n' : c === 'r' ? '\r' : c
    ));
  }
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) {
    return v.slice(1, -1);
  }
  // Number, but only if it round-trips exactly (avoid mangling ids/dates). A
  // shape match alone is not enough: '007' matches the integer regex but
  // parseInt('007', 10) === 7, and String(7) !== '007' — that would silently
  // drop the leading zero (and similarly mangle an oversized int that loses
  // precision as a JS number). Compare the stringified-back value against the
  // original text and only coerce when they match exactly; otherwise keep it
  // as the original string.
  if (/^-?\d+$/.test(v)) {
    const n = parseInt(v, 10);
    return String(n) === v ? n : v;
  }
  if (/^-?\d*\.\d+$/.test(v)) {
    const n = parseFloat(v);
    return String(n) === v ? n : v;
  }
  return v;
}

// A scalar needs quoting if it could be misread on parse (looks like a bool/
// null/number, is empty, or contains a leading/trailing space or a colon-space
// that would confuse the key:value split), OR contains a newline/CR — a raw
// newline would otherwise split a single field into extra "lines" that could
// forge a sibling frontmatter key or a `---` fence (frontmatter injection);
// quoting+escaping keeps it a single physical line.
function needsQuote(v) {
  if (v === '') return true;
  if (/^(null|~|true|false)$/.test(v)) return true;
  if (/^-?\d+(\.\d+)?$/.test(v)) return true;
  if (/^[\s]|[\s]$/.test(v)) return true;
  if (/[:#]/.test(v)) return true;
  if (/[\n\r]/.test(v)) return true;
  // A value beginning with a YAML indicator char (block seq `-`, flow
  // collections, anchors/aliases, tags, block/quote scalars, directives) is
  // mis-parsed or invalid when written bare in a file a real YAML reader sees.
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(v)) return true;
  return false;
}

function serializeScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  const s = String(v);
  if (needsQuote(s)) {
    // Escape order matters: backslash FIRST, so the backslashes introduced by
    // the \n/\r escaping below are never themselves re-escaped.
    const escaped = s
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r');
    return '"' + escaped + '"';
  }
  return s;
}

// Parse a full record file (markdown with frontmatter). Fails SAFE: on any
// malformed input it returns a record with the raw text as body and an empty
// frontmatter rather than throwing, so a hook reading a poisoned/corrupt file
// never crashes the session (D11 fail-open posture, matches lib/io.js).
//
// D28.3 shape: `name`/`description` are top-level scalars; every forge
// operational field lives one level down under a `metadata:` block. This
// parser therefore supports exactly ONE level of nesting — the `metadata:`
// block only — and nothing deeper (§3.2's "bounded one-level nesting").
//
// Returns { frontmatter, extra, body, malformed }
//   frontmatter — { name, description, metadata: {...} } — whichever of these
//                 top-level fields were present; `metadata` is a real nested
//                 object of whichever recognized/unknown sub-keys were present
//   extra       — any other TOP-LEVEL key:value lines preserved verbatim
//                 (migration losslessness for a pre-existing non-memory-v2 file)
//   body        — everything after the closing fence
//   malformed   — true if there was no valid frontmatter block
// (No `order`: serializeRecord emits TOP_LEVEL_ORDER, then `metadata:` in
// METADATA_ORDER, then `extra` insertion order, so a caller-visible `order`
// would imply a stability guarantee the serializer does not honor. Dropped
// rather than left as dead, misleading output.)
function parseRecord(raw) {
  const text = String(raw == null ? '' : raw);
  const empty = { frontmatter: {}, extra: {}, body: text, malformed: true };
  // Frontmatter must be the very first thing in the file.
  if (!text.startsWith('---')) return empty;
  // Find the opening fence line and the next closing fence.
  const lines = text.split('\n');
  if (lines[0].trim() !== '---') return empty;
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { close = i; break; }
  }
  if (close === -1) return empty; // unterminated frontmatter -> treat as body

  const frontmatter = {};
  const extra = {};
  let lastKey = null;
  // Explicit three-way tag for which bucket the LAST top-level key landed in,
  // so the dispatch below routes an indented continuation line unambiguously.
  // (Previously this mixed an object identity — the `frontmatter`/`extra`
  // object itself — with the string 'metadata' as a third case; three
  // parallel string tags read the same at every call site and keep the
  // three-way switch explicit rather than relying on reference equality.)
  let lastBucket = null; // one of: 'top', 'extra', 'metadata'
  let metadata = null; // becomes an object once a `metadata:` header is seen
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    // An indented continuation line. Two legitimate shapes reach here:
    //   1. a `  key: value` child of an OPEN `metadata:` block — parse it into
    //      the nested object;
    //   2. a stray indented line under `extra`'s LAST key (migration
    //      losslessness for an unrelated pre-existing nested/multiline value,
    //      e.g. a non-memory-v2 file's own nested block) — preserved verbatim,
    //      exactly as before D28.3.
    // Restricted to those two buckets ONLY: a stray indented line under a
    // TYPED top-level scalar key (`name`/`description`) must be skipped, not
    // appended — appending would turn a scalar field into a garbage string,
    // and validateFrontmatter can't catch every such case (bug #2, preserved).
    if (/^\s+\S/.test(line)) {
      if (lastBucket === 'metadata' && metadata) {
        const cm = line.match(/^\s+([A-Za-z0-9_-]+):(.*)$/);
        if (cm) metadata[cm[1]] = parseScalar(cm[2]);
        continue;
      }
      if (lastKey !== null && lastBucket === 'extra') {
        extra[lastKey] = (extra[lastKey] === null ? '' : extra[lastKey])
          + '\n' + line;
        continue;
      }
      continue; // stray indented line under a typed top-level scalar: skip
    }
    const m = line.match(/^([A-Za-z0-9_-]+):(.*)$/);
    if (!m) continue; // skip a line we can't parse; don't crash
    const key = m[1];
    const rawVal = m[2];
    if (key === 'metadata') {
      // Opens (or re-opens, if malformed input repeats the key — last wins) a
      // nested metadata block. A non-empty rawVal on the `metadata:` line
      // itself (e.g. `metadata: oops`) is not the documented shape; treat the
      // block as present but empty rather than losing it into `extra` — the
      // subsequent indented children (if any) still populate it.
      metadata = {};
      frontmatter.metadata = metadata;
      lastBucket = 'metadata';
      lastKey = key;
      continue;
    }
    const val = parseScalar(rawVal);
    if (TOP_LEVEL_ORDER.includes(key)) {
      frontmatter[key] = val;
      lastBucket = 'top';
    } else {
      extra[key] = val;
      lastBucket = 'extra';
    }
    lastKey = key;
  }

  const body = lines.slice(close + 1).join('\n');
  return { frontmatter, extra, body, malformed: false };
}

// Serialize a record { frontmatter, extra?, body } back to markdown.
// TOP_LEVEL_ORDER (name, description) leads, then a `metadata:` block whose
// children follow METADATA_ORDER (then any unknown metadata sub-keys in
// insertion order), each indented two spaces, then any top-level `extra`
// (preserved unknown keys) in insertion order. This keeps round-trips stable
// and diffs tight during migration.
function serializeRecord(record) {
  const fm = record.frontmatter || {};
  const extra = record.extra || {};
  const out = ['---'];
  for (const key of TOP_LEVEL_ORDER) {
    if (Object.prototype.hasOwnProperty.call(fm, key)) {
      // verbatimOk defaults false: name/description are typed top-level
      // scalars, never the parseRecord-produced verbatim-block shape (see
      // serializeField) — a multiline value here always falls through to the
      // quoted single-line scalar path.
      out.push(serializeField(key, fm[key]));
    }
  }
  if (fm.metadata && typeof fm.metadata === 'object' && !Array.isArray(fm.metadata)) {
    // Same: metadata's OWN header line is a nested-map value (object), not a
    // multiline string, so verbatimOk is irrelevant here; the flag matters for
    // metadata's own CHILD values, which serializeField's map branch renders
    // with serializeScalar directly (never the verbatim-block path) — see
    // serializeField's map branch.
    out.push(serializeField('metadata', fm.metadata));
  }
  for (const key of Object.keys(extra)) {
    if (key === 'metadata' || TOP_LEVEL_ORDER.includes(key)) continue; // never duplicate a schema key
    // Only `extra` values may legitimately carry the parseRecord-produced
    // verbatim indented-block shape (migration losslessness) — see
    // serializeField and isSafeVerbatimBlock.
    out.push(serializeField(key, extra[key], { verbatimOk: true }));
  }
  out.push('---');
  const body = record.body == null ? '' : String(record.body);
  // The closing fence line is terminated with its own newline; `body` is then
  // appended verbatim. parseRecord returns body as lines.slice(close+1) joined
  // by '\n', so a blank line that sat between the fence and the content shows up
  // as a leading '\n' in body — appending after the fence's own '\n' reproduces
  // the original spacing exactly. Round-trip is byte-stable (see memory.test.js).
  return out.join('\n') + '\n' + body;
}

// A multiline string is safe to emit VERBATIM as an indented block only if it
// is provably the shape parseRecord's continuation branch produces: EVERY
// continuation line (the head line's own newline-free by construction — see
// callers, which split on '\n') is already indented (`/^\s+\S/`) and none,
// once trimmed, is a bare `---` fence. Anything else (arbitrary
// caller-supplied text, e.g. unit 3's model-produced `extra` values) must NOT
// take this path — an unindented continuation line would forge a sibling
// frontmatter key (e.g. smuggling a second `id:` that overwrites the real one
// on re-parse), and an indented `---` line still closes parseRecord's
// frontmatter block early (parseRecord checks `lines[i].trim() === '---'`),
// planting body content.
function isSafeVerbatimBlock(rest) {
  for (const line of rest) {
    if (!/^\s+\S/.test(line)) return false;
    if (line.trim() === '---') return false;
  }
  return true;
}

// Serialize one field. Handles three shapes an `extra` value can take (schema
// fields are always scalar):
//   * a multiline STRING that is PROVABLY the verbatim indented-block shape
//     parseRecord's continuation branch produces (migration's `metadata:` +
//     children) — preserved verbatim as an indented block. Gated behind
//     `verbatimOk` (opt-in, default false): ONLY the `extra` serialization
//     loop in serializeRecord passes `verbatimOk: true`, because only an
//     `extra` value can legitimately have come from parseRecord's own
//     continuation-line capture. A top-level `name`/`description` (or a
//     `metadata` sub-value) is never that shape — treating a caller-supplied
//     multiline value there as a verbatim block would let an INDENTED
//     continuation line (e.g. `  id: evil` or `  ---`) reach the file, which
//     parseRecord's typed-top-level-key branch then silently discards on
//     re-parse (invalid frontmatter, data loss) rather than round-tripping;
//   * any OTHER multiline string (or any multiline string when verbatimOk is
//     false) — emitted as a single-line double-quoted scalar (serializeScalar
//     escapes \n/\r), since it cannot be trusted to already be safely
//     indented/fenced;
//   * a nested MAP (one level) — emitted as the `key:` header + `  child: val`
//     lines, exactly the block form parseRecord round-trips back into a string;
//   * an ARRAY — emitted as `key:` + `  - item` lines (YAML block sequence).
// Objects/arrays must NEVER fall through to serializeScalar (String(obj) is
// `[object Object]`, String(arr) drops structure) — that silently loses data.
function serializeField(key, value, { verbatimOk = false } = {}) {
  if (typeof value === 'string' && value.includes('\n')) {
    if (verbatimOk) {
      const [head, ...rest] = value.split('\n');
      if (isSafeVerbatimBlock(rest)) {
        // Multiline preserved block: first physical line is this key's own
        // value, the rest are already-indented child lines captured on parse.
        const headOut = head === '' ? `${key}:` : `${key}: ${serializeScalar(head)}`;
        return [headOut, ...rest].join('\n');
      }
    }
    // Not opted in, or not provably safe: fall back to a single-line quoted
    // scalar so the value can never smuggle a frontmatter key or an early
    // `---` fence.
    return `${key}: ${serializeScalar(value)}`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return `${key}: []`;
    const items = value.map((v) => `  - ${serializeScalar(v)}`);
    return [`${key}:`, ...items].join('\n');
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return `${key}: {}`;
    // The `metadata:` block (D28.3) has a canonical child order (METADATA_ORDER)
    // so its own round-trip is stable and diffs stay minimal, same rationale as
    // TOP_LEVEL_ORDER above; any unknown metadata sub-key follows in insertion
    // order. A plain nested map elsewhere (e.g. inside `extra`) has no such
    // canonical order and keeps Object.keys insertion order as before.
    const orderedKeys = key === 'metadata'
      ? [
        ...METADATA_ORDER.filter((k) => Object.prototype.hasOwnProperty.call(value, k)),
        ...keys.filter((k) => !METADATA_ORDER.includes(k)),
      ]
      : keys;
    const children = orderedKeys.map((k) => `  ${k}: ${serializeScalar(value[k])}`);
    return [`${key}:`, ...children].join('\n');
  }
  return `${key}: ${serializeScalar(value)}`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// Returns an array of human-readable problem strings; empty means valid.
// Intentionally does NOT throw — callers decide whether an invalid record is
// fatal (writeRecord refuses) or merely surfaced (a reader logging a warning).
function validateFrontmatter(fm) {
  const problems = [];
  if (!fm || typeof fm !== 'object') return ['frontmatter is not an object'];
  if (typeof fm.name !== 'string' || fm.name.trim() === '') problems.push('missing name');
  if (typeof fm.description !== 'string' || fm.description.trim() === '') problems.push('missing description');
  const md = fm.metadata;
  if (!md || typeof md !== 'object' || Array.isArray(md)) {
    problems.push('missing metadata');
    return problems; // nothing further to check without a metadata object
  }
  if (!md.id) problems.push('missing metadata.id');
  if (!TYPES.includes(md.type)) problems.push(`metadata.type must be one of ${TYPES.join('|')} (got ${JSON.stringify(md.type)})`);
  if (!md.scope) problems.push('missing metadata.scope');
  if (md.tier !== undefined && md.tier !== null && !TIERS.includes(md.tier)) {
    problems.push(`metadata.tier must be one of ${TIERS.join('|')} (got ${JSON.stringify(md.tier)})`);
  }
  if (md.importance !== undefined && md.importance !== null) {
    // Guard against empty-string / whitespace: Number('') is 0 (not NaN), so a
    // bare `importance:` line (which parseScalar yields as '') would sneak
    // through as 0 without this explicit numeric-shape check.
    const isNumericShape = typeof md.importance === 'number'
      || /^-?\d*\.?\d+$/.test(String(md.importance));
    const n = Number(md.importance);
    if (!isNumericShape || Number.isNaN(n) || n < 0 || n > 1) {
      problems.push('metadata.importance must be 0.0–1.0');
    }
  }
  if (md.source !== undefined && md.source !== null && !SOURCES.includes(md.source)) {
    problems.push(`metadata.source must be one of ${SOURCES.join('|')} (got ${JSON.stringify(md.source)})`);
  }
  if (md.uses !== undefined && md.uses !== null) {
    const isIntShape = typeof md.uses === 'number'
      || /^-?\d+$/.test(String(md.uses));
    if (!isIntShape || !Number.isInteger(Number(md.uses)) || Number(md.uses) < 0) {
      problems.push('metadata.uses must be a non-negative integer');
    }
  }
  // The schema's "bounded one-level nesting" (§3.2) means every metadata
  // sub-value must itself be a scalar. serializeField's map branch renders
  // each child with serializeScalar (see above), which silently degrades a
  // non-scalar to `[object Object]` (an object) or a comma-joined string (an
  // array) — a mangled, unrecoverable value on disk rather than a thrown
  // error. Catch it here, at the one place the rest of this schema is
  // enforced, so writeRecord refuses before that ever reaches a file.
  for (const k of Object.keys(md)) {
    const v = md[k];
    const isScalar = v === null || ['string', 'number', 'boolean'].includes(typeof v);
    if (!isScalar) {
      problems.push(`metadata.${k} must be a scalar (got ${Array.isArray(v) ? 'array' : typeof v})`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Id
// ---------------------------------------------------------------------------

// Generate an id. Prefer a caller-supplied id (a hook MUST pass one). When none
// is given, use crypto.randomUUID() — explicitly allowed by the dispatch —
// rather than Math.random(). NEVER call this bare inside a hook that is meant to
// be deterministic; pass your own id there.
function newId(supplied) {
  if (supplied) return String(supplied);
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Filesystem: scope directories, read, write/upsert, archive
// ---------------------------------------------------------------------------

// Resolve one agent scope directory. `root` is the repo's `.claude/agent-memory`
// (caller supplies it — the library never guesses cwd). `scope` maps to
// <plugin>-<scope>. Per-agent isolation (D4) is enforced here: this returns a
// single directory and nothing above it is ever read as records.
// Strict charset for a plugin/scope segment: lowercase alphanumeric + hyphen,
// must start with an alphanumeric. This BANS `/`, `.`, `..`, and any other
// separator, so `${plugin}-${scope}` can never contain a path separator and
// path.join can never escape `root`. All SCOPES and the `forge` plugin match.
const SEGMENT_RE = /^[a-z0-9][a-z0-9-]*$/;

// SEGMENT_RE stops `..`/`/` from ever appearing INSIDE a segment string, but a
// string check alone cannot stop a planted SYMLINK: if `<root>/forge-reviewer`
// (or its `_archive/` dir, or an individual record file within it) is itself a
// symlink pointing outside `root`, a naive path.join + fs call happily follows
// it off the containment boundary. assertContained() closes that gap by
// resolving real paths and checking containment before any filesystem mutation.
//
// `target` need not exist yet (e.g. a record file about to be created): walk up
// to the nearest existing ancestor, resolve THAT real path, then re-append the
// remaining (not-yet-existing) segments. If `root` itself doesn't exist yet
// there is nothing planted to escape through, so containment trivially holds.
function assertContained(root, target) {
  let realRoot;
  try {
    realRoot = fs.realpathSync(root);
  } catch (e) {
    return; // root doesn't exist yet — nothing to escape through
  }
  let cursor = target;
  const trailing = [];
  let realCursor = null;
  // Walk up from `target` until we find an existing ancestor we can realpath.
  for (;;) {
    try {
      realCursor = fs.realpathSync(cursor);
      break;
    } catch (e) {
      const parent = path.dirname(cursor);
      if (parent === cursor) { realCursor = cursor; break; } // reached fs root
      trailing.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
  const realTarget = trailing.length ? path.join(realCursor, ...trailing) : realCursor;
  const rel = path.relative(realRoot, realTarget);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`memory: path escapes root via symlink or traversal: ${target} -> ${realTarget} (root ${realRoot})`);
  }
}

function scopeDir(root, plugin, scope) {
  const p = plugin || 'forge';
  const s = String(scope);
  if (!SEGMENT_RE.test(p) || !SEGMENT_RE.test(s)) {
    throw new Error(`memory: invalid plugin/scope segment (must match ${SEGMENT_RE}): ${p}-${s}`);
  }
  return path.join(root, `${p}-${s}`);
}

// Read every record in exactly ONE scope directory. Never descends into or
// reads sibling scopes — this is the per-scope isolation guarantee (D4). Skips
// MEMORY.md (an index, not a record — §8) and any non-.md file. A malformed
// file is returned with malformed:true rather than throwing, so one poisoned
// file never blocks the rest of the scope.
//
// Returns [{ file, frontmatter, extra, body, malformed }].
function readScope(root, plugin, scope) {
  let dir;
  try {
    dir = scopeDir(root, plugin, scope);
    assertContained(root, dir); // e.g. a symlinked scope dir — fail open on READ (D11)
  } catch (e) {
    return []; // invalid scope segment, or containment violation — fail open
  }
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return []; // no such scope yet — fail open, empty
  }
  // Deterministic order: fs.readdirSync's order is filesystem-dependent, and
  // this module otherwise avoids any non-determinism (D11, see the header note).
  names.sort();
  const records = [];
  for (const name of names) {
    if (name === 'MEMORY.md') continue; // index, not a record (§8)
    if (!name.endsWith('.md')) continue;
    const full = path.join(dir, name);
    let raw;
    try {
      // lstatSync (NOT statSync) so a symlinked entry is never followed: a
      // record file that is a symlink to an external regular file would
      // otherwise pass an isFile() check made on the link's TARGET, silently
      // contradicting the per-scope containment this function advertises.
      // Symlinked entries are skipped, same as any other unreadable file.
      const st = fs.lstatSync(full);
      if (!st.isFile()) continue;
      raw = fs.readFileSync(full, 'utf8');
    } catch (e) {
      continue; // unreadable — skip, don't crash
    }
    const parsed = parseRecord(raw);
    records.push({ file: full, ...parsed });
  }
  return records;
}

// Strict, INJECTIVE filename-safe id charset. Must start with an alphanumeric;
// after that, alphanumeric/underscore/dot/hyphen only. `.` and `..` alone are
// rejected (path-segment ambiguity), and an id ending in `.md` is rejected too
// (would collide with recordFileName's own `${id}.md` suffix — `x` and `x.md`
// would otherwise both resolve to `x.md.md` / `x.md`, an aliasing hazard).
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

// The same key charset parseRecord's key-line regex accepts (`/^([A-Za-z0-9_-]+):/`
// for a top-level line, `/^\s+([A-Za-z0-9_-]+):/` for an indented metadata
// child). writeRecord validates every `extra`/`metadata` KEY against this
// before serializing — see isSafeKey's callers — because a key containing
// `\n`, `:`, or `---` would let serializeField emit a forged sibling
// frontmatter line (e.g. an `extra` key `'x\nmetadata'` producing a bare
// `metadata:` line that RE-OPENS the metadata block on re-parse, or a key
// `'x\n---\nplanted'` that plants an early closing fence). Values are already
// injection-safe (serializeScalar escapes \n/\r, or the verbatim-block path is
// now extra-only and provably safe — see isSafeVerbatimBlock); keys were not.
const SAFE_KEY_RE = /^[A-Za-z0-9_-]+$/;

function isSafeKey(k) {
  return SAFE_KEY_RE.test(String(k));
}

function isSafeId(id) {
  const s = String(id);
  if (!SAFE_ID_RE.test(s)) return false;
  if (s === '.' || s === '..') return false;
  if (/\.md$/i.test(s)) return false;
  return true;
}

// Build a filename for a record. Deterministic from the id so upsert can find
// the existing file. Callers MUST validate the id with isSafeId() first (see
// writeRecord) — this function no longer sanitizes/mangles unsafe characters:
// a lossy sanitize (e.g. replacing every unsafe char with `-`) is NOT
// injective (`a/b` and `a-b` would both map to `a-b.md`), so two distinct ids
// could silently collide and clobber each other's file on disk. Rejecting an
// unsafe id up front (writeRecord throws) keeps this mapping injective for
// every id that actually reaches the filesystem.
function recordFileName(id) {
  return `${id}.md`;
}

// Where superseded records are archived (§3.2: old kept, archived — never
// destroyed). A sibling `_archive/` dir INSIDE the same scope, so history stays
// per-scope and diff-visible. readScope does not surface archived records as
// live ones: `_archive` is a directory, so it fails readScope's `.md` +
// `isFile` filter. (There is no separate name guard — the directory nature is
// what excludes it.)
const ARCHIVE_DIR = '_archive';

// Recursively scrub every string in a JSON-ish value, pushing each redaction
// into `redactions`. Used for `extra`, which carries free-text non-schema
// fields (a migrated `description`, `metadata`, etc.) — just as much a write
// path as the body, so a secret pasted there must never reach disk unredacted.
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

// Write (create or upsert) a record.
//
// opts (D28.3 shape — a strict superset of Claude Code's native memory record):
//   root, plugin, scope   — locate the scope dir (required)
//   name, description     — top-level Anthropic fields (free-text; scrubbed like the body)
//   metadata              — PARTIAL forge fields; `metadata.id` required;
//                           `metadata.scope` defaulted from the `scope` arg
//   body                  — record body (string)
//   now                   — ISO8601 timestamp string the CALLER supplies (used to stamp
//                           `metadata.created` when omitted — see the no-Date.now
//                           note). `metadata.lastUsed` defaults to null (a fresh record has
//                           never been recalled); unit 3's recall bumps it. If `now` is
//                           absent, `created` is left to the caller's metadata.
//   supersedesId          — if set (or metadata.supersedes set), the named record's
//                           file is archived (moved to _archive/) before this write.
//
// Every write scrubs the body, `name`, `description`, every string nested in
// `metadata` (except `metadata.id`), AND every string nested in `extra`
// through scrubSecrets first. Refuses (throws) on an INVALID record — a bad
// write is a programming error the caller must see, distinct from a bad READ
// which fails open. Returns { file, redactions, archived }.
function writeRecord(opts) {
  const { root, plugin, scope, now } = opts;
  const dir = scopeDir(root, plugin, scope);

  const md = { ...(opts.metadata || {}) };
  if (!md.scope) md.scope = scope;
  if (!md.id) throw new Error('writeRecord: metadata.id is required (supply from caller, do not autogenerate inside a hook)');
  if (!isSafeId(md.id)) {
    throw new Error(`writeRecord: unsafe record id (must match ${SAFE_ID_RE}, not '.'/'..', and not end in .md): ${md.id}`);
  }
  if (now) {
    if (!md.created) md.created = now;
  }
  // Default the full §3.2 schema so a record written via the happy path has
  // every ranking field on disk (unit 3's recall reads lastUsed/uses/tier/
  // importance/source — §3.3).
  if (md.lastUsed === undefined) md.lastUsed = null;
  if (md.uses === undefined) md.uses = 0;
  if (md.supersedes === undefined) md.supersedes = null;
  if (!md.tier) md.tier = 'semantic';
  if (md.importance === undefined) md.importance = 0.5;
  if (!md.source) md.source = 'authored';

  // Scrub EVERY write path before bytes touch disk (§4): the body, `name`,
  // `description`, every string-valued `metadata` field, and every string
  // nested in `extra` (free-text non-schema fields). `metadata.id` is
  // EXCLUDED: it is a structural, already-charset-validated identifier
  // (isSafeId above), not free-text prose, and the filename is derived from it
  // below. Scrubbing it here would rewrite an id that happens to match a
  // redaction shape (e.g. `sk-1-...`) to `[REDACTED:api-key]` AFTER isSafeId
  // already passed, corrupting identity and producing a filename that never
  // went through isSafeId.
  const scrubbedBody = scrubSecrets(opts.body == null ? '' : opts.body);
  const redactions = [...scrubbedBody.redactions];
  let name = opts.name;
  if (typeof name === 'string') {
    const r = scrubSecrets(name);
    name = r.text;
    for (const red of r.redactions) redactions.push(red);
  }
  let description = opts.description;
  if (typeof description === 'string') {
    const r = scrubSecrets(description);
    description = r.text;
    for (const red of r.redactions) redactions.push(red);
  }
  for (const k of Object.keys(md)) {
    if (k === 'id') continue;
    if (typeof md[k] === 'string') {
      const r = scrubSecrets(md[k]);
      md[k] = r.text;
      for (const red of r.redactions) redactions.push(red);
    }
  }
  const scrubbedExtra = scrubValueDeep(opts.extra || {}, redactions);

  // Reject a caller-supplied KEY that could forge frontmatter on re-parse
  // (see isSafeKey/SAFE_KEY_RE above) BEFORE anything is serialized. Values
  // are already injection-safe; keys were not — a `metadata` or `extra` key
  // containing `\n`/`:`/`---` would let serializeField emit a bare sibling
  // line (e.g. `metadata:`) that re-parses as a forged block, or an early
  // closing fence. Checked on both `md` (metadata, including any unknown
  // sub-key) and `extra` (top-level unknown keys).
  for (const k of Object.keys(md)) {
    if (!isSafeKey(k)) {
      throw new Error(`writeRecord: invalid metadata key (must match ${SAFE_KEY_RE}): ${JSON.stringify(k)}`);
    }
  }
  for (const k of Object.keys(scrubbedExtra)) {
    if (!isSafeKey(k)) {
      throw new Error(`writeRecord: invalid extra key (must match ${SAFE_KEY_RE}): ${JSON.stringify(k)}`);
    }
  }

  const fm = { name, description, metadata: md };
  const problems = validateFrontmatter(fm);
  if (problems.length) {
    throw new Error(`writeRecord: invalid record: ${problems.join('; ')}`);
  }

  // A planted symlink (the scope dir itself, or an ancestor) pointing outside
  // `root` would otherwise let a write escape the store despite SEGMENT_RE
  // guarding the string form of the path — see assertContained's own comment.
  // Checked BEFORE mkdirSync (matching archiveRecord's order below) so a
  // symlinked ancestor cannot cause an empty directory to be created outside
  // root before the throw. The WRITE path must throw, not fail open (D11's
  // fail-open posture is for READS only).
  assertContained(root, dir);

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    throw new Error(`writeRecord: cannot create scope dir ${dir}: ${e.message}`);
  }

  // Archive a superseded record if asked. Keep the old file (history), never
  // delete it (§3.2). `supersedesId` is attacker-reachable metadata (or an
  // opts value) that ends up straight in a filename passed to archiveRecord's
  // renameSync — an unvalidated value like `../../../etc/passwd` would move a
  // file from OUTSIDE the scope dir into the committed store. Validate with
  // the same isSafeId() charset the record's own id already goes through,
  // and throw (write path, not fail-open) before archiveRecord ever runs.
  let archived = null;
  const supersedesId = opts.supersedesId || md.supersedes;
  if (supersedesId) {
    if (!isSafeId(supersedesId)) {
      throw new Error(`writeRecord: unsafe supersedes id (must match ${SAFE_ID_RE}, not '.'/'..', and not end in .md): ${supersedesId}`);
    }
    md.supersedes = supersedesId;
    archived = archiveRecord(dir, supersedesId);
  }

  // If anything was scrubbed, stamp the caveat INTO the record (plan §4: the
  // redaction caveat must be "documented in the record header"). It rides in
  // `extra` (not a schema field) so it serializes after the typed fields and
  // survives a round-trip. The caveat is honest: pattern scrubbing is a safety
  // net, not a guarantee.
  const extraOut = { ...scrubbedExtra };
  if (redactions.length > 0) {
    extraOut.redacted = true;
    extraOut.redactionCaveat = REDACTION_CAVEAT;
  }

  const file = path.join(dir, recordFileName(md.id));
  const out = serializeRecord({ frontmatter: { name, description, metadata: md }, extra: extraOut, body: scrubbedBody.text });
  // Write atomically: a direct fs.writeFileSync(file, out) TRUNCATES the
  // existing live record before the new bytes are durably written, so a
  // crash/ENOSPC mid-write leaves an empty/partial record with no archive to
  // fall back to (a same-id upsert archives nothing — there is nothing to
  // recover from). Instead write to a fresh temp file in the SAME directory
  // (same-dir rename is atomic on POSIX) and rename it into place; the live
  // file is only ever replaced by a single atomic rename, never truncated
  // in-place.
  const tmp = path.join(dir, `${recordFileName(md.id)}.tmp-${crypto.randomUUID()}`);
  try {
    fs.writeFileSync(tmp, out);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) { /* best-effort cleanup only */ }
    throw e;
  }
  return { file, redactions, archived };
}

// Move a record file into the scope's _archive/ dir. Returns the archive path,
// or null if the record didn't exist (nothing to archive is not an error).
// `dir` is trusted to already be containment-checked by the caller (writeRecord
// calls assertContained(root, dir) before ever reaching here); this function
// additionally guards the archive dir itself, since that is a second directory
// a planted symlink could target independently of the scope dir.
// `id` is expected to already be isSafeId()-validated by the caller (writeRecord
// does this before calling here); assertContained on src/dest below is defense
// in depth in case a future caller forgets that check.
function archiveRecord(dir, id) {
  const src = path.join(dir, recordFileName(id));
  assertContained(dir, src);
  try {
    if (!fs.statSync(src).isFile()) return null;
  } catch (e) {
    // Genuinely missing source = nothing to archive (benign). Any OTHER fs
    // error (permissions, etc.) is a real fault and must NOT be swallowed:
    // a superseding write must not proceed as if the old record were archived.
    if (e.code === 'ENOENT') return null;
    throw new Error(`memory: cannot stat record to archive (${src}): ${e.message}`);
  }
  const archiveDir = path.join(dir, ARCHIVE_DIR);
  // A symlinked `_archive/` dir must not let an archive move land outside the
  // scope's parent tree. Check against dir's parent (the scope root's parent),
  // matching the containment boundary writeRecord already enforces for `dir`.
  assertContained(path.dirname(dir), archiveDir);
  // fs failure here is fatal, not swallowed — see above.
  fs.mkdirSync(archiveDir, { recursive: true });
  // Never clobber an existing archived version: suffix with a counter.
  let dest = path.join(archiveDir, recordFileName(id));
  let n = 1;
  while (fs.existsSync(dest)) {
    dest = path.join(archiveDir, `${recordFileName(id).replace(/\.md$/, '')}.${n}.md`);
    n++;
  }
  assertContained(dir, dest);
  // fs failure here is fatal: if the rename fails, the old record is still
  // live, so the caller must NOT go on to write the superseding record as if
  // the archive succeeded. Let it throw (writeRecord already throws on a bad
  // write, and it archives BEFORE writing the new record).
  fs.renameSync(src, dest);
  return dest;
}

module.exports = {
  TYPES, SCOPES, TIERS, SOURCES, TOP_LEVEL_ORDER, METADATA_ORDER,
  REDACTION_PATTERNS, REDACTION_CAVEAT,
  scrubSecrets, scrubValueDeep,
  parseScalar, serializeScalar,
  parseRecord, serializeRecord,
  validateFrontmatter,
  newId, isSafeId,
  scopeDir, readScope, recordFileName, writeRecord, archiveRecord,
  assertContained,
  ARCHIVE_DIR,
};
