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

// The SMALL type set. Adding a type is cheap, removing one is not (§3.2), so it
// stays tight until a concrete need. Anything outside this set is invalid.
const TYPES = ['fact', 'lesson', 'decision', 'note'];

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

// Frontmatter fields in canonical serialization order. Kept explicit so a
// round-trip is stable and diffs stay minimal.
const FIELD_ORDER = [
  'id', 'type', 'scope', 'tier', 'importance',
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
  if (v === '' ) return '';
  if (v === 'null' || v === '~') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  // Quoted string: strip the quotes. For double-quoted values invert
  // serializeScalar's escaping (\\ and \") so parse is a true inverse of
  // serialize; single-quoted values are taken literally.
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    return v.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) {
    return v.slice(1, -1);
  }
  // Number, but only if it round-trips exactly (avoid mangling ids/dates).
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d*\.\d+$/.test(v)) return parseFloat(v);
  return v;
}

// A scalar needs quoting if it could be misread on parse (looks like a bool/
// null/number, is empty, or contains a leading/trailing space or a colon-space
// that would confuse the key:value split).
function needsQuote(v) {
  if (v === '') return true;
  if (/^(null|~|true|false)$/.test(v)) return true;
  if (/^-?\d+(\.\d+)?$/.test(v)) return true;
  if (/^[\s]|[\s]$/.test(v)) return true;
  if (/[:#]/.test(v)) return true;
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
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }
  return s;
}

// Parse a full record file (markdown with frontmatter). Fails SAFE: on any
// malformed input it returns a record with the raw text as body and an empty
// frontmatter rather than throwing, so a hook reading a poisoned/corrupt file
// never crashes the session (D11 fail-open posture, matches lib/io.js).
//
// Returns { frontmatter, extra, body, malformed }
//   frontmatter — the memory-v2 schema fields present (typed)
//   extra       — any other key:value lines preserved verbatim (migration)
//   body        — everything after the closing fence
//   malformed   — true if there was no valid frontmatter block
// (No `order`: serializeRecord emits FIELD_ORDER then `extra` insertion order,
// so a caller-visible `order` would imply a stability guarantee the serializer
// does not honor. Dropped rather than left as dead, misleading output.)
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
  let lastBucket = null;
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    // A nested / indented line (e.g. the `metadata:` block in existing files).
    // We don't model nesting; preserve the whole indented line under the parent
    // key so migration stays lossless. Restricted to the `extra` bucket ONLY:
    // a stray indented line under a TYPED schema key (e.g. `supersedes`) must be
    // skipped, not appended — appending would turn a scalar field into a garbage
    // string (a truthy `supersedes` triggers a bogus archive; a bad `importance`
    // is a wrong number), and validateFrontmatter can't catch every such case.
    if (/^\s+\S/.test(line) && lastKey !== null && lastBucket === extra) {
      extra[lastKey] = (extra[lastKey] === null ? '' : extra[lastKey])
        + '\n' + line;
      continue;
    }
    const m = line.match(/^([A-Za-z0-9_-]+):(.*)$/);
    if (!m) continue; // skip a line we can't parse; don't crash
    const key = m[1];
    const val = parseScalar(m[2]);
    if (FIELD_ORDER.includes(key)) {
      frontmatter[key] = val;
      lastBucket = frontmatter;
    } else {
      extra[key] = val;
      lastBucket = extra;
    }
    lastKey = key;
  }

  const body = lines.slice(close + 1).join('\n');
  return { frontmatter, extra, body, malformed: false };
}

// Serialize a record { frontmatter, extra?, body } back to markdown. The
// canonical field order (FIELD_ORDER) leads; any `extra` (preserved unknown
// keys) follows in insertion order. This keeps round-trips stable and diffs
// tight during migration.
function serializeRecord(record) {
  const fm = record.frontmatter || {};
  const extra = record.extra || {};
  const out = ['---'];
  for (const key of FIELD_ORDER) {
    if (Object.prototype.hasOwnProperty.call(fm, key)) {
      out.push(serializeField(key, fm[key]));
    }
  }
  for (const key of Object.keys(extra)) {
    if (FIELD_ORDER.includes(key)) continue; // never duplicate a schema key
    out.push(serializeField(key, extra[key]));
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

// Serialize one field. Handles three shapes an `extra` value can take (schema
// fields are always scalar):
//   * a multiline STRING preserved verbatim as an indented block (migration's
//     `metadata:` + children, captured by parseRecord's continuation branch);
//   * a nested MAP (one level) — emitted as the `key:` header + `  child: val`
//     lines, exactly the block form parseRecord round-trips back into a string;
//   * an ARRAY — emitted as `key:` + `  - item` lines (YAML block sequence).
// Objects/arrays must NEVER fall through to serializeScalar (String(obj) is
// `[object Object]`, String(arr) drops structure) — that silently loses data.
function serializeField(key, value) {
  if (typeof value === 'string' && value.includes('\n')) {
    // Multiline preserved block: first physical line is this key's own value,
    // the rest are already-indented child lines captured on parse.
    const [head, ...rest] = value.split('\n');
    const headOut = head === '' ? `${key}:` : `${key}: ${serializeScalar(head)}`;
    return [headOut, ...rest].join('\n');
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return `${key}: []`;
    const items = value.map((v) => `  - ${serializeScalar(v)}`);
    return [`${key}:`, ...items].join('\n');
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return `${key}: {}`;
    const children = keys.map((k) => `  ${k}: ${serializeScalar(value[k])}`);
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
  if (!fm.id) problems.push('missing id');
  if (!TYPES.includes(fm.type)) problems.push(`type must be one of ${TYPES.join('|')} (got ${JSON.stringify(fm.type)})`);
  if (!fm.scope) problems.push('missing scope');
  if (fm.tier !== undefined && fm.tier !== null && !TIERS.includes(fm.tier)) {
    problems.push(`tier must be one of ${TIERS.join('|')} (got ${JSON.stringify(fm.tier)})`);
  }
  if (fm.importance !== undefined && fm.importance !== null) {
    // Guard against empty-string / whitespace: Number('') is 0 (not NaN), so a
    // bare `importance:` line (which parseScalar yields as '') would sneak
    // through as 0 without this explicit numeric-shape check.
    const isNumericShape = typeof fm.importance === 'number'
      || /^-?\d*\.?\d+$/.test(String(fm.importance));
    const n = Number(fm.importance);
    if (!isNumericShape || Number.isNaN(n) || n < 0 || n > 1) {
      problems.push('importance must be 0.0–1.0');
    }
  }
  if (fm.source !== undefined && fm.source !== null && !SOURCES.includes(fm.source)) {
    problems.push(`source must be one of ${SOURCES.join('|')} (got ${JSON.stringify(fm.source)})`);
  }
  if (fm.uses !== undefined && fm.uses !== null) {
    const isIntShape = typeof fm.uses === 'number'
      || /^-?\d+$/.test(String(fm.uses));
    if (!isIntShape || !Number.isInteger(Number(fm.uses))) {
      problems.push('uses must be an integer');
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
  const records = [];
  for (const name of names) {
    if (name === 'MEMORY.md') continue; // index, not a record (§8)
    if (!name.endsWith('.md')) continue;
    const full = path.join(dir, name);
    let raw;
    try {
      const st = fs.statSync(full);
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
// opts:
//   root, plugin, scope   — locate the scope dir (required)
//   frontmatter           — schema fields; `id` required; `scope` defaulted from `scope` arg
//   body                  — record body (string)
//   now                   — ISO8601 timestamp string the CALLER supplies (used to stamp
//                           `created` when the frontmatter omits it — see the no-Date.now
//                           note). `lastUsed` defaults to null (a fresh record has never
//                           been recalled); unit 3's recall bumps it. If `now` is absent,
//                           `created` is left to the caller's frontmatter.
//   supersedesId          — if set (or frontmatter.supersedes set), the named record's
//                           file is archived (moved to _archive/) before this write.
//
// Every write scrubs the body, the string frontmatter values, AND every string
// nested in `extra` through scrubSecrets first. Refuses (throws) on an INVALID
// record — a bad write is a
// programming error the caller must see, distinct from a bad READ which fails
// open. Returns { file, redactions, archived }.
function writeRecord(opts) {
  const { root, plugin, scope, now } = opts;
  const dir = scopeDir(root, plugin, scope);

  const fm = { ...(opts.frontmatter || {}) };
  if (!fm.scope) fm.scope = scope;
  if (!fm.id) throw new Error('writeRecord: frontmatter.id is required (supply from caller, do not autogenerate inside a hook)');
  if (!isSafeId(fm.id)) {
    throw new Error(`writeRecord: unsafe record id (must match ${SAFE_ID_RE}, not '.'/'..', and not end in .md): ${fm.id}`);
  }
  if (now) {
    if (!fm.created) fm.created = now;
  }
  // Default the full §3.2 schema so a record written via the happy path has
  // every ranking field on disk (unit 3's recall reads lastUsed/uses/tier/
  // importance/source — §3.3). `now` stamps lastUsed alongside created when the
  // caller supplies it; otherwise lastUsed starts null.
  if (fm.lastUsed === undefined) fm.lastUsed = null;
  if (fm.uses === undefined) fm.uses = 0;
  if (fm.supersedes === undefined) fm.supersedes = null;
  if (!fm.tier) fm.tier = 'semantic';
  if (fm.importance === undefined) fm.importance = 0.5;
  if (!fm.source) fm.source = 'authored';

  // Scrub EVERY write path before bytes touch disk (§4): the body, each
  // string-valued frontmatter field, and every string nested in `extra`
  // (free-text non-schema fields like a migrated `description`/`metadata`).
  const scrubbedBody = scrubSecrets(opts.body == null ? '' : opts.body);
  const redactions = [...scrubbedBody.redactions];
  for (const k of Object.keys(fm)) {
    if (typeof fm[k] === 'string') {
      const r = scrubSecrets(fm[k]);
      fm[k] = r.text;
      for (const red of r.redactions) redactions.push(red);
    }
  }
  const scrubbedExtra = scrubValueDeep(opts.extra || {}, redactions);

  const problems = validateFrontmatter(fm);
  if (problems.length) {
    throw new Error(`writeRecord: invalid record: ${problems.join('; ')}`);
  }

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    throw new Error(`writeRecord: cannot create scope dir ${dir}: ${e.message}`);
  }
  // A planted symlink (the scope dir itself, or an ancestor) pointing outside
  // `root` would otherwise let a write escape the store despite SEGMENT_RE
  // guarding the string form of the path — see assertContained's own comment.
  // The WRITE path must throw, not fail open (D11's fail-open posture is for
  // READS only).
  assertContained(root, dir);

  // Archive a superseded record if asked. Keep the old file (history), never
  // delete it (§3.2).
  let archived = null;
  const supersedesId = opts.supersedesId || fm.supersedes;
  if (supersedesId) {
    fm.supersedes = supersedesId;
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

  const file = path.join(dir, recordFileName(fm.id));
  const out = serializeRecord({ frontmatter: fm, extra: extraOut, body: scrubbedBody.text });
  // Write atomically: a direct fs.writeFileSync(file, out) TRUNCATES the
  // existing live record before the new bytes are durably written, so a
  // crash/ENOSPC mid-write leaves an empty/partial record with no archive to
  // fall back to (a same-id upsert archives nothing — there is nothing to
  // recover from). Instead write to a fresh temp file in the SAME directory
  // (same-dir rename is atomic on POSIX) and rename it into place; the live
  // file is only ever replaced by a single atomic rename, never truncated
  // in-place.
  const tmp = path.join(dir, `${recordFileName(fm.id)}.tmp-${crypto.randomUUID()}`);
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
function archiveRecord(dir, id) {
  const src = path.join(dir, recordFileName(id));
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
  // fs failure here is fatal: if the rename fails, the old record is still
  // live, so the caller must NOT go on to write the superseding record as if
  // the archive succeeded. Let it throw (writeRecord already throws on a bad
  // write, and it archives BEFORE writing the new record).
  fs.renameSync(src, dest);
  return dest;
}

module.exports = {
  TYPES, SCOPES, TIERS, SOURCES, FIELD_ORDER,
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
