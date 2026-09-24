'use strict';
// memory-v2 adoption migration engine (docs/plans/memory-v2.md D28.2/D28.4,
// unit 4 of the thin-layer breakdown).
//
// Generalizes the retired unit-1 seed (scripts/migrate-agent-memory.js on
// claude/mv2-u1-record-schema, never merged — see docs/plans/memory-v2.md
// D28.4 "DROP" list) from "add frontmatter to this repo's own files" into
// forge's install-time capability: adapt a CONSUMER repo's pre-existing
// agent memory/lessons, in ANY prior shape, into the native memory-v2 record
// format (D28.3) — non-destructively (the "Bluegrass rule").
//
// No npm dependencies (D11). No Date.now()/Math.random(): timestamps and ids
// are supplied by the caller (plugins/forge/scripts/migrate-agent-memory.js
// passes an ISO `now` string and `crypto.randomUUID` is only ever called
// once per NEW record, never re-derived). This module is a script/library
// invoked by a human-run command, not a hook, but keeping the same
// discipline here means it stays safe to import from a hook later without
// re-auditing it.
//
// Non-destructive guarantee (D28.2, "the Bluegrass rule"): a pre-existing
// file that isn't ALREADY a valid native record is never edited in place.
// Its pristine bytes are moved (never deleted) to
// `.claude/agent-memory/_pre-migration/<scope>/<original-relative-path>`,
// mirroring the source layout, and a brand-new native record file is written
// at the original location instead. A file that's already a valid native
// record (has `metadata.id`) is left untouched and NOT archived — there is
// nothing to migrate, which is also what makes a re-run a no-op.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { scrubSecrets } = require('../../hooks/lib/redact');

const AGENT_MEMORY_DIRNAME = '.claude/agent-memory';
const PRE_MIGRATION_DIRNAME = '_pre-migration';

// Sentinel for "this frontmatter key's value could not be parsed" — a bare
// `key:` with no inline value, where `key` isn't `metadata` (the one shape
// that legitimately opens a nested block). This is DELIBERATELY distinct
// from a real, parsed YAML null (`key: null`, `key: ~`, or `key:` followed
// by nothing meaningful is otherwise indistinguishable from an intentional
// null scalar) — the two must never collapse into the same value, or a
// consumer can no longer tell "this really was null" from "this couldn't be
// read at all". A key carrying this sentinel is omitted from
// buildNativeRecord's legacy fold (never written into the migrated record as
// `null`); the pristine original — including this key's real, unparsed-here
// value — survives untouched in the `_pre-migration/` archive per the
// Bluegrass rule, so nothing is actually lost, only left out of the reshaped
// copy.
const UNPARSED = Symbol('memory-migrate:unparsed-frontmatter-value');

// Mirrors plugins/forge/hooks/memory-redact.js's MAX_SCRUB_BYTES posture: a
// record file bigger than this is skipped and reported rather than read in
// full — bounds worst-case memory/time for one poisoned or truly enormous
// file, same as the hook applies to its own scrub-on-write path.
const MAX_RECORD_BYTES = 256 * 1024;

// D28.3 type vocabulary: Anthropic's four subject-types plus forge's own
// `decision` extension. A recognized `metadata.type` (or legacy top-level
// `type`) on a pre-existing file carries straight through; anything else
// (missing, unrecognized, or a completely different prior shape) falls back
// to `project` — the safe default for "some pre-existing state/context
// note" (§3.2: retyping later is cheap).
const TYPES = new Set(['user', 'feedback', 'project', 'reference', 'decision']);

// A path segment forge derives a directory/file name from must be validated
// before use — never trust an arbitrary consumer-repo directory name as a
// path component without checking its shape first (mirrors the posture of
// scripts/lib/changelog-fragment.js's resolveInside, generalized here to
// segment names rather than a whole path). Lower-kebab plus underscore, the
// same shape forge's own scope/slug names already use (forge-implementer,
// feedback_local_testing_scope.md).
const SEGMENT_RE = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;

function isValidSegment(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= 128 && SEGMENT_RE.test(s);
}

// Resolves `relPath` against `root` and refuses anything that escapes it,
// lexically (path.resolve + prefix check) AND physically (realpath of the
// deepest existing ancestor) — same two-check shape as
// scripts/lib/changelog-fragment.js's resolveInside, reused rather than
// re-implemented differently: a consumer repo's directory names are exactly
// the kind of "project-controlled string this derives a path from" that
// function exists to guard.
function resolveInside(root, relPath) {
  const rootReal = fs.realpathSync(root);
  const abs = path.resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`path escapes repository root: ${relPath}`);
  }
  let cur = abs;
  for (;;) {
    if (fs.existsSync(cur)) {
      const real = fs.realpathSync(cur);
      if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
        throw new Error(`path resolves (through a symlink) to outside the repository: ${relPath}`);
      }
      break;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return abs;
}

// Atomic write: write to a sibling temp file then rename over the target, so
// a crash mid-write never leaves a corrupt record where a good one (or a
// clean absence) used to be.
function writeFileAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${crypto.randomUUID()}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

// Moves a pristine original out of the live tree into the pre-migration
// archive, mirroring its source-relative layout. Uses rename for the common
// case (same filesystem); falls back to copy-then-unlink only if rename
// fails (e.g. EXDEV, a cross-device archive root) — either way the content
// lands in the archive before the source path is freed for the new record,
// and the source is never left behind once the archive copy exists.
//
// NEVER clobbers an existing archive entry: a second, DIFFERENT original
// destined for the same `<scope>/<name>` archive path (e.g. a human re-adds
// a note at a previously-migrated path and re-runs migration) must not
// silently overwrite the pristine first original. When the exact
// destination is already taken, this finds the first free
// `<name>.<n><ext>` sibling instead — the archive path chosen is returned
// so the caller can report it — rather than throwing, so a re-run never
// loses an original.
function archiveOriginal(absSourceFile, archiveDestFile) {
  fs.mkdirSync(path.dirname(archiveDestFile), { recursive: true });
  let dest = archiveDestFile;
  if (fs.existsSync(dest)) {
    const dir = path.dirname(archiveDestFile);
    const ext = path.extname(archiveDestFile);
    const stem = path.basename(archiveDestFile, ext);
    let n = 1;
    do {
      dest = path.join(dir, `${stem}.${n}${ext}`);
      n++;
    } while (fs.existsSync(dest));
  }
  try {
    fs.renameSync(absSourceFile, dest);
  } catch (e) {
    fs.copyFileSync(absSourceFile, dest);
    fs.unlinkSync(absSourceFile);
  }
  return dest;
}

// ---- frontmatter parsing --------------------------------------------------
//
// Deliberately minimal: this engine does not need to be a general YAML
// parser, only to recognize the ONE shape native memory-v2 records use
// (D28.3: `name`/`description` top-level scalars, `metadata:` a one-level
// nested block of scalars) well enough to tell "already native" from "some
// other shape", and to read out whatever scalar fields a non-native file's
// frontmatter happens to have (so they can be carried through under
// `metadata.legacy` rather than silently dropped).

function parseScalar(raw) {
  const v = raw.trim();
  if (v === 'null' || v === '~' || v === '') return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v.startsWith('"') && v.endsWith('"')) {
    const inner = v.slice(1, -1);
    // True inverse of yamlScalar's double-quote escaping: a single pass over
    // the full escape set so a LITERAL two-character `\n` in the source
    // (backslash followed by the letter n, as opposed to an escaped real
    // newline) is never misread as an escaped newline, and vice versa. Order
    // inside the character class doesn't matter here because the match is on
    // the escape marker (backslash + one of these four characters), not on
    // the characters standing alone.
    return inner.replace(/\\(["\\nr])/g, (_, c) => {
      if (c === 'n') return '\n';
      if (c === 'r') return '\r';
      return c; // \" -> " , \\ -> \
    });
  }
  if (v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1);
  }
  return v;
}

// Splits `raw` into { frontmatter, body }. `frontmatter` is a flat map of
// top-level keys to either a scalar or, for exactly `metadata:`, a nested
// flat map (one level, matching D28.3's "bounded one-level nesting"). A file
// with no `---`-delimited frontmatter at all (plain markdown lessons,
// pre-frontmatter era) returns an empty frontmatter object and the whole
// file as `body`.
function parseRecord(raw) {
  // Accept both LF (`---\n`) and CRLF (`---\r\n`) opening delimiters — a
  // CRLF-line-ended record is routine in a Windows consumer checkout (the
  // exact adoption scenario this engine targets) and must be recognized as
  // frontmatter, not misclassified as a plain-markdown body (which would
  // wrongly archive+rewrite an already-native CRLF record every run).
  const startMatch = /^---\r?\n/.exec(raw);
  if (!startMatch) {
    return { frontmatter: {}, body: raw, hadUnrecognizedLine: false };
  }
  const fmStart = startMatch[0].length;
  // Closing delimiter must be `---` ALONE on its own line — `\n---` followed
  // immediately by end-of-string or a line break (optionally trailing
  // whitespace before the line break), never `\n---` as a mere PREFIX of a
  // longer line (e.g. a body paragraph that starts "---some other text",
  // or a markdown thematic break followed by trailing prose on the same
  // line some editors can produce). Matching a `---`-prefixed line as the
  // terminator would truncate the frontmatter block early and misparse
  // whatever followed `---` on that line as the START of the body, silently
  // losing/mangling content. Search starting exactly at fmStart (the first
  // byte of the frontmatter block itself) so the match offset maps directly
  // onto `raw` with no off-by-one bookkeeping.
  const closeRe = /\r?\n---[ \t]*(\r?\n|$)/;
  const closeMatch = closeRe.exec(raw.slice(fmStart));
  if (!closeMatch) return { frontmatter: {}, body: raw, hadUnrecognizedLine: false };
  const end = fmStart + closeMatch.index;
  const fmBlock = raw.slice(fmStart, end);
  let rest = raw.slice(end + closeMatch[0].length);

  const frontmatter = {};
  // Tracks whether ANY frontmatter line fell through to the "unrecognized
  // line shape" drop path below (deeper nesting, a list, etc. this minimal
  // parser doesn't model). Distinct from `UNPARSED` (a recognized bare
  // `key:` whose VALUE couldn't be read) — this is a whole LINE this parser
  // couldn't even attribute to a key at all. Surfaced by buildNativeRecord as
  // a `metadata.migrationNotes` pointer so the drop is visible rather than
  // silent; the pristine original (including the unrecognized line) is
  // preserved untouched in the `_pre-migration/` archive either way.
  let hadUnrecognizedLine = false;
  // Strip a trailing \r from each line so CRLF-authored frontmatter parses
  // identically to LF: without this, `(.*)$` below would swallow the \r
  // into the captured value and every scalar in a CRLF record would carry
  // a stray trailing carriage return.
  const lines = fmBlock.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  let currentNestedKey = null;
  for (const line of lines) {
    if (line.trim() === '') continue;
    const nestedMatch = /^ {2}([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    const topMatch = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (nestedMatch && currentNestedKey) {
      // Mirror the top-level bare-`key:` handling below: a nested key with no
      // inline value (e.g. `  foo:` under `metadata:`) is exactly as
      // unreadable to this minimal parser as a bare top-level key would be —
      // it could be the start of a deeper block/list this parser doesn't
      // model, whose real content lives on following lines. Marking it
      // UNPARSED (rather than parseScalar's `''` -> `null` fold) keeps a
      // fabricated `null` from ever being written into the migrated record;
      // buildNativeRecord's nested-legacy fold already skips UNPARSED entries.
      frontmatter[currentNestedKey][nestedMatch[1]] = nestedMatch[2].trim() === '' ? UNPARSED : parseScalar(nestedMatch[2]);
      continue;
    }
    if (topMatch) {
      const [, key, value] = topMatch;
      if (value.trim() === '') {
        // Bare `key:` with no inline value starts a nested block ONLY when
        // the key is exactly `metadata` (D28.3's one nesting point).
        // Anything else with no inline value is NOT distinguishable from an
        // intentional null scalar by this minimal parser (unlike `key: null`
        // or `key: ~`, which go through parseScalar and are a deliberately
        // parsed null) — a bare `key:` could equally be the start of a list
        // or deeper block this parser doesn't model, whose real content sits
        // on FOLLOWING lines this loop will now misread as unrelated
        // top-level keys. Marking it UNPARSED (rather than guessing `null`)
        // means buildNativeRecord omits it from the migrated record instead
        // of writing a fabricated `null` over content that might not
        // actually be empty; the pristine original (with the key's real
        // value, whatever shape it is) is untouched in the pre-migration
        // archive either way.
        if (key === 'metadata') {
          frontmatter[key] = {};
          currentNestedKey = key;
          continue;
        }
        frontmatter[key] = UNPARSED;
        currentNestedKey = null;
        continue;
      }
      frontmatter[key] = parseScalar(value);
      currentNestedKey = null;
      continue;
    }
    // Unrecognized line shape inside frontmatter (deeper nesting, a list,
    // etc.): not modeled by this minimal parser. Leaving currentNestedKey
    // null (rather than throwing) means the file is simply classified as
    // non-native below and the ENTIRE original is preserved verbatim in the
    // pre-migration archive — nothing is lost, it's just not parsed further.
    currentNestedKey = null;
    hadUnrecognizedLine = true;
  }
  // If NOTHING inside the `---`...`---` block matched a recognized key
  // shape, this was never a real frontmatter block to begin with — most
  // likely a markdown thematic break (`---`) that a human used as a plain
  // prose separator, with ANOTHER `---` line somewhere later in the body
  // coincidentally closing what looked like a frontmatter delimiter pair.
  // Treating an empty-of-keys `frontmatter` as "valid, if vacuous,
  // frontmatter" would silently drop everything between the two `---`
  // lines (mistaken for a frontmatter block) from the migrated body,
  // permanently losing that content. Falling back to the WHOLE raw file as
  // plain-markdown `body` here guarantees content is always preserved,
  // matching the no-`---`-at-all case above.
  if (Object.keys(frontmatter).length === 0) {
    return { frontmatter: {}, body: raw, hadUnrecognizedLine: false };
  }
  return { frontmatter, body: rest, hadUnrecognizedLine };
}

function yamlScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  // ALWAYS double-quote a string scalar. This predicate used to conditionally
  // quote based on a growing list of "looks ambiguous to a real YAML reader"
  // shapes (leading `[`/`{`, a trailing `:`, YAML-1.1 booleans like
  // `yes`/`no`/`on`/`off`/`y`/`n`, case-insensitive `True`/`NULL`, hex/octal/
  // binary numerics like `0x1F`, sexagesimal-looking numbers, `.inf`/`.nan`,
  // reserved indicator characters, etc.) — every reviewer pass found another
  // edge case a real standards-compliant YAML 1.1/1.2 parser would misread,
  // because the list can never be complete. A double-quoted scalar has NO
  // such ambiguity: it is unambiguous to read as a string by ANY conformant
  // YAML reader (native Claude Code included) and by this module's own
  // `parseScalar`, so there is no predicate left to maintain or fall behind.
  //
  // Non-string types (number/boolean/null, handled above) are emitted
  // unquoted as before — this only affects string scalars.
  return `"${s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')}"`;
}

// Serializes { name, description, metadata, body } into the exact D28.3
// on-disk shape (verified against real native records in
// .claude/agent-memory/forge-implementer/*.md in this repo).
function serializeRecord({ name, description, metadata, body }) {
  const lines = ['---', `name: ${yamlScalar(name)}`, `description: ${yamlScalar(description)}`, 'metadata:'];
  for (const k of Object.keys(metadata)) {
    lines.push(`  ${k}: ${yamlScalar(metadata[k])}`);
  }
  lines.push('---', '');
  const trimmedBody = body.replace(/^\n+/, '').replace(/\s+$/, '');
  return lines.join('\n') + (trimmedBody ? trimmedBody + '\n' : '');
}

// ---- classification --------------------------------------------------------

// True when `frontmatter` already IS a valid D28.3 native record: a `name`,
// a `description`, and a `metadata` object carrying a non-empty `id`. `id`
// presence is the idempotency marker — a record this engine (or native
// memory itself) has already stamped is left alone, which is also what
// makes a second run a no-op.
function isNativeRecord(frontmatter) {
  if (!frontmatter || typeof frontmatter.name !== 'string' || !frontmatter.name) return false;
  if (typeof frontmatter.description !== 'string' || !frontmatter.description) return false;
  const md = frontmatter.metadata;
  if (!md || typeof md !== 'object') return false;
  return typeof md.id === 'string' && md.id.length > 0;
}

// D28.3 migration mapping: `feedback→feedback`, `project→project`,
// `user→user`, `reference→reference` (an old top-level `type` or
// `metadata.type` value carries through as-is since all four are already in
// the new vocabulary); anything unrecognized (missing, a PMB-style type not
// in the new set, or absent entirely) falls back to `project`.
function classifyType(frontmatter) {
  const candidate = (frontmatter.metadata && frontmatter.metadata.type) || frontmatter.type;
  return TYPES.has(candidate) ? candidate : 'project';
}

// `dirName` is like `forge-implementer` -> { plugin: 'forge', scope:
// 'implementer' }. The FIRST `-` is the split point (matches how every
// existing forge-* directory in this repo is named); a directory with no
// `-` at all is treated as plugin `forge` with that whole name as scope
// (the safe default — this only affects where an ALREADY-agent-memory-shaped
// directory's records land, never whether they're picked up at all).
function scopeFromDir(dirName) {
  const idx = dirName.indexOf('-');
  if (idx === -1) return { plugin: 'forge', scope: dirName };
  return { plugin: dirName.slice(0, idx), scope: dirName.slice(idx + 1) };
}

// Scrubs every string surface a migrated record can carry: the body, name,
// description, and every string-valued metadata field. Matches the posture
// documented in docs/plans/memory-v2.md §3.4 ("every write runs the
// redaction scrubber first") and mirrors memory-redact.js's use of the same
// scrubSecrets function, so "migrated" and "native-written" get identical
// scrub coverage.
function scrubRecordFields(name, description, body, metadata) {
  const redactions = [];
  const scrub = (s) => {
    const r = scrubSecrets(s);
    redactions.push(...r.redactions);
    return r.text;
  };
  // D28.5 finding #4: scrubbing a metadata value BARE (just the value string,
  // with no surrounding text) loses the `KEY=`/`key:` context redact.js's
  // `secret-assignment` pattern requires to recognize it as a credential
  // assignment at all — a legacy field like `metadata.legacy.auth_token:
  // "abc123XYZ456"` would scrub to nothing, because the bare value
  // `abc123XYZ456` alone doesn't match ANY pattern (secret-assignment always
  // needs its keyword+separator prefix; the other patterns need their own
  // fixed prefix, e.g. `ghp_`/`AKIA`/etc., which a metadata VALUE may not
  // carry even though the surrounding `key: value` shape is exactly what a
  // human would call a leaked secret). Reconstructing `${k}=${v}` (a TIGHT
  // assignment — no surrounding whitespace) restores that context
  // unconditionally: `isTightAssignment` in secret-assignment's `replace`
  // matches on the bare `=` shape ALONE regardless of the keyword's case or
  // separator style, so this catches a generic secret in a metadata field
  // even when the field's own key name (e.g. `note`, `author`) doesn't look
  // identifier-shaped by itself. The reconstructed `${k}=` prefix is stripped
  // back off the scrubbed result afterward so the metadata value itself
  // (not `key=value`) is what's stored — only the REDACTION, if any, is kept
  // from the wrapped pass. Redaction counts stay exact: `scrub` above already
  // pushes into `redactions` for every actual replacement, and re-stripping
  // the prefix is a pure string operation that doesn't invent or drop a
  // count.
  const scrubMetadataValue = (k, v) => {
    const prefix = `${k}=`;
    const wrapped = scrub(`${prefix}${v}`);
    return wrapped.startsWith(prefix) ? wrapped.slice(prefix.length) : wrapped;
  };
  const scrubbedMetadata = {};
  for (const k of Object.keys(metadata)) {
    const v = metadata[k];
    scrubbedMetadata[k] = typeof v === 'string' ? scrubMetadataValue(k, v) : v;
  }
  return {
    name: scrub(name),
    description: scrub(description),
    body: scrub(body),
    metadata: scrubbedMetadata,
    redactions,
  };
}

// Builds a slug from a filename: strips a leading `<type>_`/`<type>-` prefix
// if the prefix is already a recognized type (native's own convention,
// e.g. `feedback_local_testing_scope.md`), then kebab-cases what remains.
// This only affects the human-facing `name` field, never the on-disk
// filename (the file keeps its original basename so links/paths already
// pointing at it in prose stay valid).
function slugFromFilename(base) {
  const stem = base.replace(/\.md$/, '');
  const prefixMatch = /^([a-z]+)[_-](.+)$/.exec(stem);
  const rest = prefixMatch && TYPES.has(prefixMatch[1]) ? prefixMatch[2] : stem;
  return rest.replace(/_/g, '-').toLowerCase();
}

// Turns one pre-existing (non-native) record's parsed shape into a full
// D28.3 native record ready to serialize. `now` is an ISO8601 string
// supplied by the caller (never computed here — see header). `id` is
// supplied by the caller too (crypto.randomUUID(), called once per file by
// plugins/forge/scripts/migrate-agent-memory.js) so this function stays pure/deterministic
// and independently testable with fixed inputs.
function buildNativeRecord({ frontmatter, body, scope, baseName, now, id, hadUnrecognizedLine }) {
  const type = classifyType(frontmatter);
  const name = typeof frontmatter.name === 'string' && frontmatter.name
    ? frontmatter.name
    : slugFromFilename(baseName);
  const description = typeof frontmatter.description === 'string' && frontmatter.description
    ? frontmatter.description
    : name;

  // Preserve every unrecognized pre-existing frontmatter key losslessly
  // under metadata.legacy, BEFORE the canonical fields are assigned, so a
  // same-named legacy key never shadows type/scope/id/etc. Top-level keys
  // already consumed above (name/description/type) and the nested
  // `metadata` object itself are excluded from `legacy` — their content is
  // either already reflected in the canonical fields or, for a pre-existing
  // `metadata` block's OWN unrecognized keys, folded in one level down
  // rather than double-nested.
  //
  // A key whose value parseRecord marked UNPARSED (a bare `key:` this
  // minimal parser couldn't read — see parseRecord) is deliberately OMITTED
  // here rather than folded in as a fabricated `null`: writing `null` would
  // silently misrepresent "couldn't parse this" as "this really was empty",
  // and it's the record body/metadata a human or agent reads back later, not
  // the archive. The real value survives regardless, untouched, in the
  // pristine original under `_pre-migration/` (the Bluegrass rule) — nothing
  // is lost, it's just not carried into the reshaped copy. `hadUnparsed`
  // tracks whether this happened at all, so the caller can surface a
  // `metadata.migrationNotes` pointer when it did.
  let hadUnparsed = false;
  const legacy = {};
  for (const k of Object.keys(frontmatter)) {
    if (k === 'name' || k === 'description' || k === 'type' || k === 'metadata') continue;
    if (frontmatter[k] === UNPARSED) {
      hadUnparsed = true;
      continue;
    }
    legacy[k] = frontmatter[k];
  }
  if (frontmatter.metadata && typeof frontmatter.metadata === 'object') {
    for (const k of Object.keys(frontmatter.metadata)) {
      if (k === 'type') continue;
      if (frontmatter.metadata[k] === UNPARSED) {
        hadUnparsed = true;
        continue;
      }
      legacy[k] = frontmatter.metadata[k];
    }
  }

  const metadata = {
    type,
    scope,
    id,
    tier: 'semantic', // pre-existing, human/agent-curated content — durable knowledge, not a fresh working note
    importance: 0.5,
    created: now,
    lastUsed: null,
    uses: 0,
    source: 'migrated', // provenance: this record was adapted from a pre-existing shape, not authored fresh
    supersedes: null,
  };
  // Visible pointer (rather than a silent omission) that at least one
  // pre-existing frontmatter key couldn't be parsed and was left out of
  // `legacy` above — its real value is not lost, only not reflected here;
  // the pristine original (which does hold it) is archived under
  // `_pre-migration/`.
  //
  // Same pointer (same field, same "preserved in _pre-migration" phrasing)
  // for `hadUnrecognizedLine`: a whole line inside the original frontmatter
  // block that parseRecord couldn't even attribute to a key at all (deeper
  // nesting, a list, etc.) was silently dropped from BOTH `frontmatter` and
  // therefore from this migrated record's metadata. Surfacing it here means
  // that drop is visible instead of silent, even though (same as UNPARSED)
  // nothing is actually lost — the pristine original, unrecognized line
  // included, survives untouched in the archive.
  if (hadUnparsed || hadUnrecognizedLine) {
    metadata.migrationNotes = 'unparsed frontmatter keys preserved in _pre-migration';
  }
  // Fold legacy fields in last, so a legacy key can never overwrite a
  // canonical one above (canonical always wins on collision) but anything
  // NOT already a canonical key is still carried through losslessly.
  for (const k of Object.keys(legacy)) {
    if (!(k in metadata)) metadata[k] = legacy[k];
  }

  const scrubbed = scrubRecordFields(name, description, body, metadata);
  return {
    record: { name: scrubbed.name, description: scrubbed.description, metadata: scrubbed.metadata, body: scrubbed.body },
    redactions: scrubbed.redactions,
  };
}

// ---- MEMORY.md index -------------------------------------------------------

// Rebuilds/creates the scope's MEMORY.md index from the set of native record
// files now present in `scopeDir` (post-migration). Entries are sorted by
// filename for determinism. A pre-existing MEMORY.md's own content is not a
// "record" (it carries no frontmatter and is never a migration TARGET), so
// there is nothing to archive for it — it is simply regenerated to include
// any newly-migrated records that aren't already indexed. An existing line
// for a file that's still present is preserved verbatim (never rewritten)
// so a human's own wording/description in the index isn't churned by a
// migration run.
function buildMemoryIndex(scopeDir, recordFiles) {
  const indexPath = path.join(scopeDir, 'MEMORY.md');
  let existingLines = [];
  if (fs.existsSync(indexPath)) {
    existingLines = fs.readFileSync(indexPath, 'utf8').split('\n');
  }
  const indexedFiles = new Set();
  for (const line of existingLines) {
    // Anchored to the entry's OWN leading link (`- [title](file.md)` at the
    // start of the line, only whitespace before it) so a `](other.md)`-shaped
    // link inside human-authored hook/description prose later in the same
    // line can never register as an indexed filename and mask a real record
    // from being (re-)indexed.
    const m = /^\s*-\s*\[[^\]]*\]\(([^)]+\.md)\)/.exec(line);
    if (m) indexedFiles.add(m[1]);
  }
  const newLines = [];
  // Tracks, PER SOURCE RECORD FILE, the EXACT count of redactions indexing
  // it produced — needed by the caller to report accurate WARNING counts
  // AND location (SECURITY 3/provenance): a redaction here can come from a
  // record this same run just migrated (archived under `_pre-migration/`)
  // OR from an already-native record that was simply never indexed before
  // (never archived — the Bluegrass rule leaves it live on disk untouched).
  // Those two cases need DIFFERENT warning text, and a single file can
  // legitimately contribute MORE THAN ONE redaction (e.g. two distinct
  // secrets in its description) — a boolean "was this file touched" is not
  // enough for the caller to do exact redaction-count arithmetic, so this
  // is `{ file, count }` per entry, never just a flat list of filenames.
  const redactedFileCounts = new Map(); // file -> running redaction count (title/hook text only)
  const addRedaction = (file, n) => {
    if (n <= 0) return;
    redactedFileCounts.set(file, (redactedFileCounts.get(file) || 0) + n);
  };
  // Tracked SEPARATELY from `redactedFileCounts`: a filename-shaped secret's
  // raw value sits at the file's LIVE path regardless of whether this run
  // migrated the record (and archived its original elsewhere) or found it
  // already native — the archive copy, if any, is ALSO named the same
  // secret-shaped thing, so pointing only at `_pre-migration/` for this case
  // would still leave the live, committed filename unflagged. This is why
  // it's kept apart from the migrate-vs-native split the caller otherwise
  // does for title/hook redactions: a filename-shaped secret is always a
  // "look at this live path and rename it" case, never a plain "check the
  // archive" one.
  const filenameRedactedFileCounts = new Map();
  const addFilenameRedaction = (file, n) => {
    if (n <= 0) return;
    filenameRedactedFileCounts.set(file, (filenameRedactedFileCounts.get(file) || 0) + n);
  };
  for (const file of recordFiles.slice().sort()) {
    if (indexedFiles.has(file)) continue;
    const full = path.join(scopeDir, file);
    let title = path.basename(file, '.md');
    let hook = 'migrated record';
    try {
      const { frontmatter } = parseRecord(fs.readFileSync(full, 'utf8'));
      if (typeof frontmatter.name === 'string' && frontmatter.name) title = frontmatter.name;
      if (typeof frontmatter.description === 'string' && frontmatter.description) hook = frontmatter.description;
    } catch (e) {
      // keep the filename-derived fallback
    }
    // A title containing `[`, `]`, or a line break corrupts the
    // `- [title](target)` markdown link syntax itself (an unescaped `]`
    // closes the link text early; a raw newline breaks the single-line
    // list-item shape this index format requires). Sanitize BEFORE
    // scrubbing/interpolation so the emitted line is always a valid,
    // resolvable link regardless of what a pre-existing `name:` field
    // happens to contain.
    const linkSafeTitle = title.replace(/[\r\n]+/g, ' ').replace(/[[\]]/g, '');
    // §3.4: scrub the human-text fields (title/hook) INDIVIDUALLY, never the
    // link target. `file` is the record's own on-disk basename (already
    // filename-safe, derived from its id/slug) and must stay a valid link —
    // scrubbing it here would rewrite a secret-shaped filename (e.g. a
    // source record literally named `AKIA....md`) into a redaction
    // placeholder, breaking the link while leaving the real file unlinked
    // and invisible to native hub reads. See buildNativeRecord's
    // scrubRecordFields, which scrubs fields separately for the same reason.
    const scrubTitle = scrubSecrets(linkSafeTitle);
    const scrubHook = scrubSecrets(hook);
    const totalRedactions = scrubTitle.redactions.length + scrubHook.redactions.length;
    addRedaction(file, totalRedactions);
    // SECURITY (filename-shaped secret, unwarned): a record whose FILENAME
    // itself is secret-shaped (e.g. `ghp_<36 chars>.md`, `AKIA....md`) must
    // keep that real filename as the link TARGET (breaking the link to "fix"
    // this would leave the real on-disk record unlinked/invisible — same
    // reasoning as the title/hook-vs-target split above). But leaving it
    // silently unflagged means a credential-shaped string sits in the
    // committed MEMORY.md with no notice at all. So it's scrubbed here for
    // DETECTION ONLY — the scrubbed text is discarded, only whether it found
    // anything is kept — and a hit is tracked separately (never mixed into
    // this file's title/hook `redactions` total) so the caller's provenance
    // tracking (and therefore the closing CLI WARNING) names this file and
    // prompts a rename + credential rotation.
    const filenameScrub = scrubSecrets(file);
    addFilenameRedaction(file, filenameScrub.redactions.length);
    newLines.push({ line: `- [${scrubTitle.text}](${file}) — ${scrubHook.text}`, redactions: totalRedactions });
  }
  if (newLines.length === 0) return { changed: false, redactions: 0, redactedFiles: [], carryThroughRedactions: 0 };
  // Only drop TRAILING blank lines (so new entries append cleanly after
  // whatever was already there); every INTERNAL blank line in a
  // human-authored hub is preserved as-is. The previous behavior stripped
  // every blank line unconditionally, collapsing paragraph/heading
  // separation in a live, human-edited MEMORY.md on every migration run.
  let lastNonBlank = existingLines.length - 1;
  while (lastNonBlank >= 0 && existingLines[lastNonBlank].trim() === '') lastNonBlank--;
  const body = existingLines.slice(0, lastNonBlank + 1);
  // §3.4: every write runs through the redaction scrubber first. A secret in
  // a pre-existing hand-authored MEMORY.md line (never scrubbed elsewhere,
  // since migrateScopeDir explicitly skips MEMORY.md as "not a record") must
  // still not survive into the rewritten index. But scrubbing the WHOLE
  // assembled markdown (as before) rewrites link TARGETS too: a pre-existing
  // entry line whose file target happens to be secret-shaped gets its link
  // corrupted the same way a freshly-built entry would. So each carried-
  // through line is parsed for a leading `- [title](target)` link (the EXACT
  // same anchor the `indexedFiles` dedup scan above uses — no requirement of
  // a trailing ` — hook` or any particular separator, since a pre-existing
  // hub line may have no hook at all, or use `-`/`–` instead of an em-dash);
  // when it matches, the title AND any trailing text after the link (the
  // hook, whatever its separator) are scrubbed individually and the
  // `(target.md)` is left alone, exactly like the newly-built entries above.
  // A line that doesn't match that shape is arbitrary human prose (not a
  // link entry) with no target to protect, so it is scrubbed whole, same as
  // before.
  let redactionCount = 0;
  // Counts EXACTLY how many redactions came from carry-through (pre-existing
  // hub line) content, for the same SECURITY-3 provenance reason as
  // `redactedFileCounts` above: that content lives only in MEMORY.md itself
  // (never archived to `_pre-migration/`, since migrateScopeDir never treats
  // MEMORY.md as a migration source), so the caller must attribute this
  // exact count to the index file's own live path, not the archive, and
  // never fold it into a file-count-based subtraction (a single carry-
  // through line can hold more than one secret).
  let carryThroughRedactions = 0;
  const scrubbedBody = body.map((line) => {
    const m = /^(\s*-\s*\[)([^\]]*)(\]\()([^)]+\.md)(\))(.*)$/.exec(line);
    if (m) {
      const [, pre, title, mid, target, close, rest] = m;
      // Same link-safety sanitization as the newly-built entries above: a
      // carried-through title should never already contain `[`/`]`/a
      // newline (it came from inside a matched `[...]` link), but sanitize
      // defensively so reconstruction can never re-emit a broken link.
      const linkSafeTitle = title.replace(/[\r\n]+/g, ' ').replace(/[[\]]/g, '');
      const st = scrubSecrets(linkSafeTitle);
      const sr = scrubSecrets(rest);
      const lineRedactions = st.redactions.length + sr.redactions.length;
      redactionCount += lineRedactions;
      carryThroughRedactions += lineRedactions;
      return `${pre}${st.text}${mid}${target}${close}${sr.text}`;
    }
    const { text, redactions } = scrubSecrets(line);
    redactionCount += redactions.length;
    carryThroughRedactions += redactions.length;
    return text;
  });
  for (const entry of newLines) redactionCount += entry.redactions;
  // FIX E: a filename-shaped-secret detection is a real redaction-worthy
  // finding (a credential-shaped string sitting in the committed index),
  // even though the emitted link text for it is unchanged (the target is
  // deliberately left unscrubbed) — count it so `redactions > 0` triggers
  // the closing CLI WARNING pass for this file's finding, same as any other
  // secret this function catches.
  for (const count of filenameRedactedFileCounts.values()) redactionCount += count;
  const finalLines = scrubbedBody.concat(newLines.map((e) => e.line));
  const assembled = finalLines.join('\n') + '\n';
  writeFileAtomic(indexPath, assembled);
  // Exact per-file redaction counts (SECURITY 3 provenance), NEVER a
  // file-count list — a single file can contribute more than one redaction
  // and the caller must be able to do exact arithmetic against `redactions`
  // above, not approximate it by subtracting a file count from a redaction
  // count.
  const redactedFiles = Array.from(redactedFileCounts, ([file, count]) => ({ file, count }));
  // FIX E: filename-shaped-secret detections, kept separate from
  // `redactedFiles` — these are ALWAYS a live-path ("rename this file")
  // finding regardless of whether the record was migrated or already
  // native, so the caller routes them straight into its native/live
  // WARNING bucket rather than splitting them by migrate-vs-native status.
  const filenameRedactedFiles = Array.from(filenameRedactedFileCounts, ([file, count]) => ({ file, count }));
  return { changed: true, redactions: redactionCount, redactedFiles, filenameRedactedFiles, carryThroughRedactions };
}

// D28.5 finding #7: an already-native record (has name/description/
// metadata.id — isNativeRecord already confirmed this) can still predate the
// full D28.3 ranking-field set, e.g. a record written before `tier`/
// `importance`/etc. existed. Such a record was previously skipped UNTOUCHED
// forever (the Bluegrass rule's "already native, leave alone" path), which
// means it would never actually gain the fields native memory's own recall
// path expects. This tops up ONLY the missing ranking fields, in place,
// preserving every existing value byte-for-byte — never rewrites a value
// that's already present, never re-archives, never touches name/description/
// any pre-existing metadata key. Returns `null` (a true no-op) when nothing
// is missing, so a fully-formed record is guaranteed byte-identical after a
// run — the caller must not even attempt a write in that case.
const RANKING_FIELD_DEFAULTS = {
  tier: 'semantic',
  importance: 0.5,
  uses: 0,
  lastUsed: null,
  source: 'migrated',
  supersedes: null,
};

function topUpRankingFields(frontmatter, body) {
  const md = frontmatter.metadata;
  const missing = Object.keys(RANKING_FIELD_DEFAULTS).filter((k) => !(k in md));
  if (missing.length === 0) return null;
  const newMetadata = {};
  // Preserve the EXISTING key order first (never reorders/rewrites a
  // pre-existing value), then append only the missing keys — so a diff
  // against the original shows purely additive lines.
  for (const k of Object.keys(md)) {
    if (md[k] === UNPARSED) continue; // never fabricate a value for a key this parser couldn't read
    newMetadata[k] = md[k];
  }
  for (const k of missing) {
    newMetadata[k] = RANKING_FIELD_DEFAULTS[k];
  }
  const serialized = serializeRecord({
    name: frontmatter.name,
    description: frontmatter.description,
    metadata: newMetadata,
    body,
  });
  return { serialized, filled: missing };
}

// ---- orchestration ----------------------------------------------------------

// Walks one scope directory (e.g. `.claude/agent-memory/forge-implementer`)
// and migrates every non-native `.md` record it directly contains (no
// recursion into `_pre-migration/` or any other subdirectory — those are
// migration artifacts or out of scope, never re-scanned).
function migrateScopeDir(root, dirName, opts) {
  const memRoot = path.join(root, AGENT_MEMORY_DIRNAME);
  const dirPath = path.join(memRoot, dirName);
  const { plugin, scope } = scopeFromDir(dirName);
  const results = [];
  let names;
  try {
    names = fs.readdirSync(dirPath);
  } catch (e) {
    return results;
  }
  const recordFilesForIndex = [];
  // Filenames left untouched because they were ALREADY native (the Bluegrass
  // rule: never archived, never rewritten). Needed after buildMemoryIndex
  // runs so a redaction it reports against one of these files can be
  // attributed correctly (SECURITY 3): the secret still sits in this LIVE
  // record, never in `_pre-migration/`, since this file was never archived.
  const nativeSkipFiles = new Set();
  for (const name of names) {
    if (name === 'MEMORY.md') continue; // an index, never a record
    if (name === PRE_MIGRATION_DIRNAME) continue; // the archive itself
    if (!name.endsWith('.md')) continue;
    const full = path.join(dirPath, name);
    let st;
    try {
      st = fs.lstatSync(full);
    } catch (e) {
      continue;
    }
    if (!st.isFile()) continue; // a symlink or directory here is left untouched, never followed

    if (st.size > MAX_RECORD_BYTES) {
      results.push({
        file: path.join(dirName, name),
        action: 'error',
        reason: `file too large to migrate (${st.size} bytes > ${MAX_RECORD_BYTES} cap) — left untouched`,
      });
      continue;
    }

    // Reading a consumer repo's pre-existing file must never abort the
    // whole run: an unreadable file (EACCES, a directory-vs-file race after
    // the lstat above, deleted between readdir and here) is reported as a
    // per-file error and skipped, same posture as the segment-validation
    // and archive/write error paths below — not fatal to sibling scopes or
    // even sibling files in the SAME scope.
    let raw;
    try {
      raw = fs.readFileSync(full, 'utf8');
    } catch (e) {
      results.push({ file: path.join(dirName, name), action: 'error', reason: e.message });
      continue;
    }
    const { frontmatter, body, hadUnrecognizedLine } = parseRecord(raw);

    if (isNativeRecord(frontmatter)) {
      const topped = topUpRankingFields(frontmatter, body);
      if (topped) {
        if (!opts.dryRun) {
          try {
            writeFileAtomic(full, topped.serialized);
          } catch (e) {
            results.push({ file: path.join(dirName, name), action: 'error', reason: e.message });
            continue;
          }
        }
        recordFilesForIndex.push(name);
        nativeSkipFiles.add(name);
        results.push({
          file: path.join(dirName, name),
          action: opts.dryRun ? 'would-top-up' : 'top-up',
          reason: `filled missing ranking field(s): ${topped.filled.join(', ')}`,
        });
        continue;
      }
      recordFilesForIndex.push(name);
      nativeSkipFiles.add(name);
      results.push({ file: path.join(dirName, name), action: 'skip', reason: 'already native' });
      continue;
    }

    if (!isValidSegment(plugin) || !isValidSegment(scope)) {
      results.push({ file: path.join(dirName, name), action: 'error', reason: `unsafe plugin/scope segment derived from directory name "${dirName}"` });
      continue;
    }

    const { record, redactions } = buildNativeRecord({
      frontmatter,
      body,
      scope,
      baseName: name,
      now: opts.now,
      hadUnrecognizedLine,
      id: opts.nextId(),
    });
    const serialized = serializeRecord(record);

    let archivedAt; // relative path actually used for the archive copy; set only on the non-dry-run path
    if (!opts.dryRun) {
      // A path-containment violation (e.g. a planted symlink escaping the
      // archive root) or any other archive/write failure must be reported
      // and skipped, never fatal to the rest of the run — one poisoned file
      // should not abort migration of every other scope. Mirrors the
      // isValidSegment error path above: push a structured error and move on.
      try {
        const archiveRel = path.join(AGENT_MEMORY_DIRNAME, PRE_MIGRATION_DIRNAME, dirName, name);
        const archiveAbs = resolveInside(root, archiveRel);
        const archiveDest = archiveOriginal(full, archiveAbs);
        archivedAt = path.relative(root, archiveDest);
        writeFileAtomic(full, serialized);
      } catch (e) {
        results.push({ file: path.join(dirName, name), action: 'error', reason: e.message });
        continue;
      }
    }
    recordFilesForIndex.push(name);
    results.push({
      file: path.join(dirName, name),
      action: opts.dryRun ? 'would-migrate' : 'migrate',
      type: record.metadata.type,
      redactions: redactions.length,
      archivedAt,
    });
  }

  if (!opts.dryRun && recordFilesForIndex.length) {
    const idx = buildMemoryIndex(dirPath, recordFilesForIndex);
    if (idx.changed) {
      // SECURITY 3: attribute WHERE each index-scrub redaction's raw secret
      // still lives, BY EXACT COUNT (never by subtracting a file count from
      // a redaction count — a single file can carry more than one secret),
      // so the CLI's closing WARNING can report precise totals and point at
      // the right place instead of always assuming `_pre-migration/`. A
      // redacted file that was migrated THIS run has its raw original
      // archived there — its count is "migrated". A redacted file in
      // `nativeSkipFiles` was never archived (Bluegrass rule — already
      // native, left untouched) and its raw secret still sits in that LIVE
      // record — its count is "native". Carry-through redactions (a
      // pre-existing MEMORY.md hub line) have no source record at all — the
      // raw secret lives only in the index file itself, also a live/native
      // path, tracked separately as its own exact count.
      const nativeRedactedPaths = []; // [{ path, count }] — live paths, never archived
      let migratedRedactions = 0; // exact count whose raw original IS archived under _pre-migration/
      for (const { file, count } of idx.redactedFiles || []) {
        if (nativeSkipFiles.has(file)) {
          nativeRedactedPaths.push({ path: path.join(dirName, file), count });
        } else {
          migratedRedactions += count;
        }
      }
      if (idx.carryThroughRedactions > 0) {
        nativeRedactedPaths.push({ path: path.join(dirName, 'MEMORY.md'), count: idx.carryThroughRedactions });
      }
      // FIX E: a filename-shaped-secret finding is ALWAYS a live-path
      // ("rename this file") finding, regardless of whether the record was
      // migrated this run (its archive copy is ALSO named the same
      // secret-shaped thing, so pointing only at `_pre-migration/` would
      // still leave the live, committed filename unflagged) or already
      // native — so this is unconditionally routed into `nativeRedactedPaths`
      // rather than split by `nativeSkipFiles` membership like the title/hook
      // redactions above.
      for (const { file, count } of idx.filenameRedactedFiles || []) {
        nativeRedactedPaths.push({ path: path.join(dirName, file), count });
      }
      results.push({
        file: path.join(dirName, 'MEMORY.md'),
        action: 'index-updated',
        redactions: idx.redactions,
        migratedRedactions,
        nativeRedactedPaths,
      });
    }
  }
  return results;
}

// Top-level entry point: discovers every `<plugin>-<scope>` directory under
// `.claude/agent-memory/` (skipping `_pre-migration/` itself) and migrates
// each. `opts.now` (ISO string) and `opts.nextId` (a () => string producer,
// normally crypto.randomUUID) are supplied by the caller so this function
// has no hidden clock/randomness of its own.
function migrateRepo(root, opts) {
  const memRoot = path.join(root, AGENT_MEMORY_DIRNAME);
  let dirs;
  try {
    dirs = fs.readdirSync(memRoot);
  } catch (e) {
    return { results: [], memRootExists: false };
  }
  const results = [];
  for (const dirName of dirs) {
    if (dirName === PRE_MIGRATION_DIRNAME) continue;
    const dirPath = path.join(memRoot, dirName);
    let st;
    try {
      st = fs.lstatSync(dirPath);
    } catch (e) {
      continue;
    }
    if (!st.isDirectory()) continue;
    results.push(...migrateScopeDir(root, dirName, opts));
  }
  return { results, memRootExists: true };
}

// ---- additive consumer-layout migration (D28.2/D28.4, unit 4 Part A) -------
//
// migrateRepo/migrateScopeDir (above) reshape files that are ALREADY under
// `.claude/agent-memory/<plugin>-<scope>/`. A real adoption target (modeled
// here on the bluegrass-middleware consumer repo) instead keeps its
// pre-existing agent memory somewhere else entirely:
//   - per-agent spokes: `.claude/agents/memory/<agent>.md`
//   - a shared hub: `tasks/lessons.md`
// migrateRepo finds NOTHING there (it never scans those paths), so this is a
// SEPARATE, purely ADDITIVE path: it reads those two source shapes and
// PRODUCES new native records under `.claude/agent-memory/<scope>/` WITHOUT
// ever touching the sources — no archive, no rewrite, no move. The Bluegrass
// rule (D28.2) still holds; there is simply nothing to archive because the
// source file itself is never altered. `.claude/rules/` is forge-native
// path-scoped auto-load config, NOT agent memory, and is never scanned here.

const AGENTS_MEMORY_SPOKES_DIR = '.claude/agents/memory';
const LESSONS_HUB_PATH = 'tasks/lessons.md';
const COORDINATOR_SCOPE = 'coordinator';

// A `## <heading sentence> (YYYY-MM-DD)` entry heading — the date suffix is
// OPTIONAL (a heading with no trailing parenthetical date is still a valid
// entry, just falls back to `opts.now` for `metadata.created`).
const ENTRY_HEADING_RE = /^##[ \t]+(.*?)(?:[ \t]*\((\d{4}-\d{2}-\d{2})\))?[ \t]*$/;

// Splits `raw` markdown into a list of `## `-headed entries: `{ heading,
// date, body }` where `body` is the raw text between this heading and the
// next `## ` heading (or end of file). A `## Index` heading is INCLUDED here
// (filtering it out, when required, is the caller's job via `skipHeadings` —
// see hub parsing below) so this one parser serves both source shapes.
function splitHeadingEntries(raw) {
  const lines = raw.split(/\r\n|\n/);
  const entries = [];
  let current = null;
  for (const line of lines) {
    const m = ENTRY_HEADING_RE.exec(line);
    if (m) {
      if (current) entries.push(current);
      current = { heading: m[1].trim(), date: m[2] || null, bodyLines: [] };
      continue;
    }
    if (current) current.bodyLines.push(line);
  }
  if (current) entries.push(current);
  return entries.map((e) => ({ heading: e.heading, date: e.date, body: e.bodyLines.join('\n') }));
}

// A `**Label:**` block within an entry body. Text runs until the next
// `**Label:**` line or end of the entry's own body (entries are already
// split at the next `## ` heading by splitHeadingEntries, so there's no
// heading boundary to worry about here). Recognizes ANY `**Word...:**`
// label, not just Mistake/Rule/Trigger — an unrecognized label is preserved
// verbatim (by label name) rather than dropped, per the spec's "other labels
// may appear — preserve them".
const LABEL_LINE_RE = /^\*\*([A-Za-z][A-Za-z0-9 _-]*):\*\*[ \t]*(.*)$/;

function parseLabelBlocks(body) {
  const lines = body.split('\n');
  const labels = {}; // label (lowercased) -> { display, text }
  const order = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    const text = current.textLines.join('\n').trim();
    const key = current.label.toLowerCase();
    if (!(key in labels)) order.push(key);
    labels[key] = { display: current.label, text };
  };
  for (const line of lines) {
    const m = LABEL_LINE_RE.exec(line);
    if (m) {
      flush();
      current = { label: m[1].trim(), textLines: m[2] ? [m[2]] : [] };
      continue;
    }
    if (current) current.textLines.push(line);
  }
  flush();
  return { labels, order };
}

// D28.3 §3.2 body convention: lead paragraph = Rule, then **Why:** = Mistake,
// then **How to apply:** = Trigger. Any OTHER label on the source entry is
// preserved verbatim, appended after those three, in its original order —
// never silently dropped.
function buildConsumerBody(labels, order) {
  const parts = [];
  const rule = labels['rule'];
  const mistake = labels['mistake'];
  const trigger = labels['trigger'];
  if (rule && rule.text) parts.push(rule.text);
  if (mistake && mistake.text) parts.push(`**Why:** ${mistake.text}`);
  if (trigger && trigger.text) parts.push(`**How to apply:** ${trigger.text}`);
  for (const key of order) {
    if (key === 'rule' || key === 'mistake' || key === 'trigger') continue;
    const entry = labels[key];
    if (entry && entry.text) parts.push(`**${entry.display}:** ${entry.text}`);
  }
  return parts.join('\n\n') + (parts.length ? '\n' : '');
}

// Bounded kebab-slug of a heading sentence: lowercase, non-alnum runs become
// a single hyphen, trimmed of leading/trailing hyphens, capped at ~80 chars
// (cut on a hyphen boundary where possible so the slug doesn't end mid-word).
function slugFromHeading(sentence) {
  let slug = sentence
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length > 80) {
    const cut = slug.slice(0, 80);
    const lastHyphen = cut.lastIndexOf('-');
    slug = (lastHyphen > 40 ? cut.slice(0, lastHyphen) : cut).replace(/-+$/, '');
  }
  return slug || 'entry';
}

// Deterministic id: sha1(scope + ' ' + headingSentence). Deliberately NOT
// crypto.randomUUID() — determinism is what makes a re-run idempotent (the
// SAME source entry must always resolve to the SAME id, so the collision
// probe below can recognize "this exact entry was already migrated" without
// needing to persist a separate id map anywhere). This is not a hidden clock
// or hidden randomness (the two things D11/the header comment forbid): a
// content hash of caller-supplied strings is pure and reproducible.
function deterministicEntryId(scope, headingSentence) {
  return crypto.createHash('sha1').update(`${scope} ${headingSentence}`).digest('hex');
}

// Turns one parsed entry (`{ heading, date, body }`) plus its `scope` into a
// full D28.3 native record, scrubbed. `now` is the caller-supplied ISO
// fallback for `metadata.created` when the heading carries no `(date)`.
function buildConsumerRecord({ heading, date, body }, scope, now) {
  const { labels, order } = parseLabelBlocks(body);
  const name = slugFromHeading(heading);
  const description = heading;
  const recordBody = buildConsumerBody(labels, order);
  const id = deterministicEntryId(scope, heading);
  const metadata = {
    type: 'feedback',
    scope,
    id,
    tier: 'semantic',
    importance: 0.5,
    created: date || now,
    lastUsed: null,
    uses: 0,
    source: 'migrated',
    supersedes: null,
  };
  const scrubbed = scrubRecordFields(name, description, recordBody, metadata);
  return {
    record: { name: scrubbed.name, description: scrubbed.description, metadata: scrubbed.metadata, body: scrubbed.body },
    redactions: scrubbed.redactions,
  };
}

// Finds the first available `<type>_<slug>[-N].md` filename in `scopeDir`
// for this record's deterministic id, per the collision-resolution contract:
//   - candidate doesn't exist -> write here (first free slot).
//   - candidate exists with the SAME id -> already migrated; caller no-ops.
//   - candidate exists with a DIFFERENT id -> distinct entry that collided
//     on slug; try the next numbered suffix.
// Returns `{ path, alreadyMigrated }` — `path` is null only if literally
// every probed suffix (up to a generous bound) is taken by a distinct id,
// which practically never happens but is handled rather than looping
// forever.
const MAX_COLLISION_PROBES = 1000;

function resolveConsumerRecordPath(scopeDir, type, slug, id) {
  for (let n = 1; n <= MAX_COLLISION_PROBES; n++) {
    const name = n === 1 ? `${type}_${slug}.md` : `${type}_${slug}-${n}.md`;
    const full = path.join(scopeDir, name);
    if (!fs.existsSync(full)) return { path: full, name, alreadyMigrated: false };
    let existingId = null;
    try {
      const { frontmatter } = parseRecord(fs.readFileSync(full, 'utf8'));
      if (frontmatter.metadata && typeof frontmatter.metadata === 'object') {
        existingId = frontmatter.metadata.id;
      }
    } catch (e) {
      // Unreadable candidate: treat as occupied-by-something-else and probe
      // the next suffix rather than risk clobbering an unreadable file.
    }
    if (existingId === id) return { path: full, name, alreadyMigrated: true };
  }
  return { path: null, name: null, alreadyMigrated: false };
}

// Migrates one source file's entries (spoke or hub) into native records
// under `.claude/agent-memory/<scope>/`, returning per-entry result objects.
// `skipHeading` (e.g. `(h) => h.toLowerCase() === 'index'`) lets the hub
// parser exclude the `## Index` section's tombstone pointers, which are not
// records at all.
function migrateConsumerSource(root, sourceRelPath, scope, opts, skipHeading) {
  const results = [];
  const absSource = path.join(root, sourceRelPath);
  let raw;
  try {
    const st = fs.lstatSync(absSource);
    if (!st.isFile()) return results;
    if (st.size > MAX_RECORD_BYTES) {
      return [{ file: sourceRelPath, action: 'error', reason: `file too large to migrate (${st.size} bytes > ${MAX_RECORD_BYTES} cap) — left untouched` }];
    }
    raw = fs.readFileSync(absSource, 'utf8');
  } catch (e) {
    return results; // source doesn't exist — nothing to do, not an error
  }

  if (!isValidSegment(scope)) {
    return [{ file: sourceRelPath, action: 'error', reason: `unsafe scope segment derived from "${scope}"` }];
  }

  const entries = splitHeadingEntries(raw).filter((e) => !(skipHeading && skipHeading(e.heading)));
  if (entries.length === 0) return results;

  const scopeDirRel = path.join(AGENT_MEMORY_DIRNAME, scope);
  let scopeDirAbs;
  try {
    scopeDirAbs = resolveInside(root, scopeDirRel);
  } catch (e) {
    return [{ file: sourceRelPath, action: 'error', reason: e.message }];
  }

  const recordFilesForIndex = [];
  for (const entry of entries) {
    try {
      const { record, redactions } = buildConsumerRecord(entry, scope, opts.now);
      const resolved = resolveConsumerRecordPath(scopeDirAbs, record.metadata.type, record.name, record.metadata.id);
      if (resolved.alreadyMigrated) {
        recordFilesForIndex.push(resolved.name);
        results.push({ file: path.join(scopeDirRel, resolved.name), action: 'skip', reason: 'already migrated (idempotent)' });
        continue;
      }
      if (!resolved.path) {
        results.push({ file: sourceRelPath, action: 'error', reason: `could not find a free record path for entry "${entry.heading}"` });
        continue;
      }
      const serialized = serializeRecord(record);
      if (!opts.dryRun) {
        writeFileAtomic(resolved.path, serialized);
      }
      recordFilesForIndex.push(resolved.name);
      results.push({
        file: path.join(scopeDirRel, resolved.name),
        action: opts.dryRun ? 'would-migrate' : 'migrate',
        type: record.metadata.type,
        redactions: redactions.length,
        source: sourceRelPath,
      });
    } catch (e) {
      results.push({ file: sourceRelPath, action: 'error', reason: `entry "${entry.heading}": ${e.message}` });
    }
  }

  if (!opts.dryRun && recordFilesForIndex.length) {
    const idx = buildMemoryIndex(scopeDirAbs, recordFilesForIndex);
    if (idx.changed) {
      const nativeRedactedPaths = [];
      let migratedRedactions = 0;
      // Every record this path writes is FRESH (no archive concept here at
      // all — nothing was ever moved), so any redaction the index build
      // finds is attributed the same way a freshly-migrated (never
      // previously-indexed) record's would be: it's a live path, not an
      // archived one — there is no `_pre-migration/` copy to point at for
      // this source, so it goes in `nativeRedactedPaths` rather than
      // `migratedRedactions` (which specifically means "archived original
      // exists").
      for (const { file, count } of idx.redactedFiles || []) {
        nativeRedactedPaths.push({ path: path.join(scopeDirRel, file), count });
      }
      for (const { file, count } of idx.filenameRedactedFiles || []) {
        nativeRedactedPaths.push({ path: path.join(scopeDirRel, file), count });
      }
      if (idx.carryThroughRedactions > 0) {
        nativeRedactedPaths.push({ path: path.join(scopeDirRel, 'MEMORY.md'), count: idx.carryThroughRedactions });
      }
      results.push({
        file: path.join(scopeDirRel, 'MEMORY.md'),
        action: 'index-updated',
        redactions: idx.redactions,
        migratedRedactions,
        nativeRedactedPaths,
      });
    }
  }
  return results;
}

// Top-level additive entry point (Part A): reads the two bluegrass-shaped
// consumer sources and produces native records, additively, non-
// destructively. Called by the CLI IN ADDITION to migrateRepo — this never
// touches `.claude/agent-memory/**` files that migrateRepo itself owns,
// and never touches `.claude/agents/memory/**`, `tasks/lessons.md`, or
// anything under `.claude/rules/` (the latter is never even scanned).
function migrateConsumerLayout(root, opts) {
  const results = [];

  // 1. Per-agent spokes: `.claude/agents/memory/<agent>.md`, SKIP README.md.
  // The stem IS the scope, preserved verbatim (no remap to forge's own agent
  // names, no splitting on `-`) — e.g. `feature-implementer.md` -> scope
  // `feature-implementer`.
  const spokesDirRel = AGENTS_MEMORY_SPOKES_DIR;
  const spokesDirAbs = path.join(root, spokesDirRel);
  let spokeNames = [];
  try {
    spokeNames = fs.readdirSync(spokesDirAbs);
  } catch (e) {
    spokeNames = [];
  }
  for (const name of spokeNames.slice().sort()) {
    if (name === 'README.md') continue;
    if (!name.endsWith('.md')) continue;
    let st;
    try {
      st = fs.lstatSync(path.join(spokesDirAbs, name));
    } catch (e) {
      continue;
    }
    if (!st.isFile()) continue;
    const scope = name.slice(0, -'.md'.length);
    results.push(...migrateConsumerSource(root, path.join(spokesDirRel, name), scope, opts, null));
  }

  // 2. Hub: `tasks/lessons.md`, scope = coordinator, SKIP the `## Index`
  // section entirely (tombstone pointers, not records).
  results.push(
    ...migrateConsumerSource(root, LESSONS_HUB_PATH, COORDINATOR_SCOPE, opts, (heading) => heading.trim().toLowerCase() === 'index')
  );

  return { results };
}

module.exports = {
  AGENT_MEMORY_DIRNAME,
  PRE_MIGRATION_DIRNAME,
  MAX_RECORD_BYTES,
  TYPES,
  UNPARSED,
  isValidSegment,
  resolveInside,
  archiveOriginal,
  parseScalar,
  yamlScalar,
  parseRecord,
  serializeRecord,
  isNativeRecord,
  classifyType,
  scopeFromDir,
  slugFromFilename,
  buildNativeRecord,
  buildMemoryIndex,
  migrateScopeDir,
  migrateRepo,
  topUpRankingFields,
  AGENTS_MEMORY_SPOKES_DIR,
  LESSONS_HUB_PATH,
  COORDINATOR_SCOPE,
  splitHeadingEntries,
  parseLabelBlocks,
  buildConsumerBody,
  slugFromHeading,
  deterministicEntryId,
  buildConsumerRecord,
  resolveConsumerRecordPath,
  migrateConsumerSource,
  migrateConsumerLayout,
};
