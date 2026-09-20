#!/usr/bin/env node
'use strict';
// Fixture test for the memory-v2 adoption migration (docs/plans/memory-v2.md
// D28.2/D28.4, unit 4): builds a temp CONSUMER repo with pre-existing agent
// memory in NON-native shapes, runs scripts/migrate-agent-memory.js against
// it, and asserts the D28.2 contract end to end:
//   - content is preserved (nothing lost — the "Bluegrass rule"),
//   - records now live in native format (D28.3) at the right paths,
//   - pristine originals are archived under `_pre-migration/`, never deleted,
//   - the scope's MEMORY.md index is correct,
//   - a second run is a no-op (idempotent),
//   - a secret in a source file is scrubbed in the migrated record.
// Plain Node asserts, no dependencies (D11). Spawns the CLI as a subprocess
// (matching how plugins/forge/hooks/tests/run.js exercises hooks) so this
// also covers scripts/migrate-agent-memory.js's own argv/exit-code surface,
// not just the library.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'migrate-agent-memory.js');

let failed = 0;
let ran = 0;
function t(name, fn) {
  ran++;
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL ${name}\n    ${e.message}`);
  }
}

function mkRepo() {
  // realpathSync up front: os.tmpdir() can itself be behind a symlink
  // (macOS /tmp -> /private/tmp; a symlinked /home on some Linux setups),
  // and the migration engine's own containment checks realpath everything —
  // testing against an unresolved tmp path would silently under-exercise
  // that logic. Matches the convention in
  // plugins/forge/hooks/tests/memory-redact.test.js.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memmigrate-test-')));
  return dir;
}

function write(dir, relPath, content) {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return full;
}

function run(dir, extraArgs) {
  const r = spawnSync(process.execPath, [CLI, '--root', dir, ...(extraArgs || [])], { encoding: 'utf8' });
  return r;
}

// ---- fixture: a consumer repo with THREE pre-existing shapes --------------
//
//   1. plain markdown, no frontmatter at all (the oldest possible shape) —
//      also carries a secret that must be scrubbed on migration.
//   2. flat frontmatter with a top-level `type` (a PMB/pre-D28.3 shape),
//      not yet nested under `metadata:`.
//   3. an ALREADY-native D28.3 record (has metadata.id) — must be left
//      completely untouched and not archived.

const SECRET = 'AKIAABCDEFGHIJKLMNOP'; // shaped exactly like an AWS access key id: AKIA + 16 alphanumerics (test-only)

function buildFixture() {
  const dir = mkRepo();
  write(
    dir,
    '.claude/agent-memory/forge-implementer/plain-lesson.md',
    `# A plain lesson\n\nDon't rebase shared branches. Learned this the hard way.\n\nLeaked key: ${SECRET}\n`
  );
  write(
    dir,
    '.claude/agent-memory/forge-implementer/flat.md',
    [
      '---',
      'name: flat-note',
      'description: A flat pre-memory-v2 note',
      'type: feedback',
      'author: legacy-system',
      '---',
      '',
      'Body content for the flat note.',
      '',
    ].join('\n')
  );
  write(
    dir,
    '.claude/agent-memory/forge-reviewer/native.md',
    [
      '---',
      'name: already-native',
      'description: Already in native shape, must not change',
      'metadata:',
      '  type: project',
      '  id: 11111111-1111-1111-1111-111111111111',
      '---',
      '',
      'Untouched content.',
      '',
    ].join('\n')
  );
  return dir;
}

// ---- tests ------------------------------------------------------------------

t('exits 0 and reports counts on first run', () => {
  const dir = buildFixture();
  const r = run(dir);
  assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /2 migrated, 1 skipped, 0 errored/);
});

t('migrated records are in native D28.3 format at the original path', () => {
  const dir = buildFixture();
  run(dir);
  const engine = require('../lib/memory-migrate');

  const plainPath = path.join(dir, '.claude/agent-memory/forge-implementer/plain-lesson.md');
  const plainRaw = fs.readFileSync(plainPath, 'utf8');
  const plainParsed = engine.parseRecord(plainRaw);
  assert.ok(engine.isNativeRecord(plainParsed.frontmatter), 'plain-lesson.md should now be a native record');
  assert.strictEqual(plainParsed.frontmatter.metadata.type, 'project'); // no recognized type -> safe default
  assert.strictEqual(plainParsed.frontmatter.metadata.scope, 'implementer');
  assert.strictEqual(plainParsed.frontmatter.metadata.source, 'migrated');
  assert.ok(plainParsed.frontmatter.metadata.id, 'must have a stamped id');

  const flatPath = path.join(dir, '.claude/agent-memory/forge-implementer/flat.md');
  const flatParsed = engine.parseRecord(fs.readFileSync(flatPath, 'utf8'));
  assert.ok(engine.isNativeRecord(flatParsed.frontmatter));
  assert.strictEqual(flatParsed.frontmatter.name, 'flat-note');
  assert.strictEqual(flatParsed.frontmatter.description, 'A flat pre-memory-v2 note');
  assert.strictEqual(flatParsed.frontmatter.metadata.type, 'feedback'); // carried through, already in the D28.3 vocabulary
  assert.strictEqual(flatParsed.frontmatter.metadata.author, 'legacy-system'); // unrecognized legacy field preserved losslessly
});

t('content is preserved (Bluegrass rule) — body text survives migration', () => {
  const dir = buildFixture();
  run(dir);
  const plainPath = path.join(dir, '.claude/agent-memory/forge-implementer/plain-lesson.md');
  const body = fs.readFileSync(plainPath, 'utf8');
  assert.match(body, /Don't rebase shared branches\. Learned this the hard way\./);

  const flatPath = path.join(dir, '.claude/agent-memory/forge-implementer/flat.md');
  const flatBody = fs.readFileSync(flatPath, 'utf8');
  assert.match(flatBody, /Body content for the flat note\./);
});

t('a secret in a source file is scrubbed in the migrated record', () => {
  const dir = buildFixture();
  run(dir);
  const plainPath = path.join(dir, '.claude/agent-memory/forge-implementer/plain-lesson.md');
  const migratedBody = fs.readFileSync(plainPath, 'utf8');
  assert.ok(!migratedBody.includes(SECRET), 'secret must not survive in the live record');
  assert.match(migratedBody, /\[REDACTED:aws-access-key\]/);
});

t('pristine originals are archived under _pre-migration/, never deleted', () => {
  const dir = buildFixture();
  const originalPlain = fs.readFileSync(
    path.join(dir, '.claude/agent-memory/forge-implementer/plain-lesson.md'),
    'utf8'
  );
  const originalFlat = fs.readFileSync(path.join(dir, '.claude/agent-memory/forge-implementer/flat.md'), 'utf8');
  run(dir);

  const archivedPlain = path.join(
    dir,
    '.claude/agent-memory/_pre-migration/forge-implementer/plain-lesson.md'
  );
  const archivedFlat = path.join(dir, '.claude/agent-memory/_pre-migration/forge-implementer/flat.md');
  assert.ok(fs.existsSync(archivedPlain), 'archived original of plain-lesson.md must exist');
  assert.ok(fs.existsSync(archivedFlat), 'archived original of flat.md must exist');

  // The archived bytes are the UNMODIFIED original — including the secret,
  // in its raw pre-scrub form: the archive is a pristine snapshot, not
  // itself scrubbed (scrubbing only applies to the live migrated record).
  assert.strictEqual(fs.readFileSync(archivedPlain, 'utf8'), originalPlain);
  assert.ok(fs.readFileSync(archivedPlain, 'utf8').includes(SECRET));
  assert.strictEqual(fs.readFileSync(archivedFlat, 'utf8'), originalFlat);
});

t('already-native record is left completely untouched and not archived', () => {
  const dir = buildFixture();
  const nativePath = path.join(dir, '.claude/agent-memory/forge-reviewer/native.md');
  const before = fs.readFileSync(nativePath, 'utf8');
  run(dir);
  const after = fs.readFileSync(nativePath, 'utf8');
  assert.strictEqual(after, before, 'already-native record must not change a single byte');

  const archivedNative = path.join(dir, '.claude/agent-memory/_pre-migration/forge-reviewer/native.md');
  assert.ok(!fs.existsSync(archivedNative), 'an already-native record must not be archived — nothing was migrated');
});

t('MEMORY.md index is created and correct for the migrated scope', () => {
  const dir = buildFixture();
  run(dir);
  const indexPath = path.join(dir, '.claude/agent-memory/forge-implementer/MEMORY.md');
  assert.ok(fs.existsSync(indexPath), 'MEMORY.md must be created for a scope with migrated records');
  const index = fs.readFileSync(indexPath, 'utf8');
  assert.match(index, /\(plain-lesson\.md\)/);
  assert.match(index, /\(flat\.md\)/);
  assert.match(index, /flat-note/); // uses the record's own description as the index hook
});

t('a second run is a no-op (idempotent): no further migration, no archive churn, no index churn', () => {
  const dir = buildFixture();
  run(dir);

  function walkInto(base, sink) {
    for (const name of fs.readdirSync(base)) {
      const full = path.join(base, name);
      const st = fs.lstatSync(full);
      if (st.isDirectory()) walkInto(full, sink);
      else sink[full] = fs.readFileSync(full, 'utf8');
    }
  }

  const snapshotBefore = {};
  walkInto(path.join(dir, '.claude', 'agent-memory'), snapshotBefore);

  const r2 = run(dir);
  assert.strictEqual(r2.status, 0, `stderr: ${r2.stderr}`);
  assert.match(r2.stdout, /0 migrated, 3 skipped, 0 errored, 0 index\(es\) updated/);

  const snapshotAfter = {};
  walkInto(path.join(dir, '.claude', 'agent-memory'), snapshotAfter);
  assert.deepStrictEqual(
    Object.keys(snapshotAfter).sort(),
    Object.keys(snapshotBefore).sort(),
    'no files should be added or removed on a second run'
  );
  for (const f of Object.keys(snapshotBefore)) {
    assert.strictEqual(snapshotAfter[f], snapshotBefore[f], `${f} must be byte-identical after a no-op second run`);
  }
});

t('--dry-run performs no writes', () => {
  const dir = buildFixture();
  const r = run(dir, ['--dry-run']);
  assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /would-migrate/);
  assert.ok(
    !fs.existsSync(path.join(dir, '.claude/agent-memory/_pre-migration')),
    'dry-run must not create the archive directory'
  );
  const stillFlat = fs.readFileSync(path.join(dir, '.claude/agent-memory/forge-implementer/flat.md'), 'utf8');
  assert.match(stillFlat, /^---\nname: flat-note\ndescription: A flat pre-memory-v2 note\ntype: feedback/);
});

t('a repo with no .claude/agent-memory at all is a clean no-op', () => {
  const dir = mkRepo();
  const r = run(dir);
  assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /nothing to migrate/);
});

t('one scope with a containment-violating planted symlink does not abort the whole run', () => {
  // Two scopes: forge-implementer (good, non-native record to migrate) and
  // forge-poisoned (its _pre-migration archive destination is hijacked by a
  // symlink pointing OUTSIDE the repo root). resolveInside must reject the
  // poisoned file's archive path, but that rejection must be reported as a
  // structured per-file error and NOT prevent the good scope from migrating.
  const dir = buildFixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memmigrate-outside-'));
  write(dir, '.claude/agent-memory/forge-poisoned/bad.md', '# A poisoned lesson\n\nSome content.\n');
  // Plant ONLY this scope's archive subdirectory as a symlink escaping the
  // repo (not the shared `_pre-migration` root itself, which the good scope
  // also archives under) — so only forge-poisoned's archive path resolves
  // outside the repository root; forge-implementer's archive path is
  // unaffected.
  fs.mkdirSync(path.join(dir, '.claude/agent-memory/_pre-migration'), { recursive: true });
  fs.symlinkSync(outside, path.join(dir, '.claude/agent-memory/_pre-migration/forge-poisoned'));

  const r = run(dir);
  assert.strictEqual(r.status, 1, `expected a non-zero exit because of the errored file; stderr: ${r.stderr}`);
  assert.match(r.stderr, /ERROR forge-poisoned[/\\]bad\.md:.*outside the repository/);
  assert.match(r.stdout, /2 migrated, 1 skipped, 1 errored/);

  // The good scope still migrated despite the other scope's poisoned file.
  const engine = require('../lib/memory-migrate');
  const plainPath = path.join(dir, '.claude/agent-memory/forge-implementer/plain-lesson.md');
  const plainParsed = engine.parseRecord(fs.readFileSync(plainPath, 'utf8'));
  assert.ok(engine.isNativeRecord(plainParsed.frontmatter), 'the good scope must still be migrated to a native record');
  const flatPath = path.join(dir, '.claude/agent-memory/forge-implementer/flat.md');
  const flatParsed = engine.parseRecord(fs.readFileSync(flatPath, 'utf8'));
  assert.ok(engine.isNativeRecord(flatParsed.frontmatter), 'the good scope must still be migrated to a native record');

  // The poisoned file itself is left in place, unmigrated (never archived,
  // never overwritten) since the archive step failed before the write.
  const poisonedPath = path.join(dir, '.claude/agent-memory/forge-poisoned/bad.md');
  assert.match(fs.readFileSync(poisonedPath, 'utf8'), /A poisoned lesson/);
});

t('yamlScalar/parseScalar round-trip a value containing an embedded newline byte-stable', () => {
  const engine = require('../lib/memory-migrate');
  const record = {
    name: 'multi-line\nname value',
    description: 'line one\nline two\r\nline three',
    metadata: { type: 'project', scope: 'implementer', id: '22222222-2222-2222-2222-222222222222', note: 'a\nb' },
    body: 'Body text.\n',
  };
  const serialized = engine.serializeRecord(record);
  // The serialized frontmatter must stay strictly line-based: no raw
  // newline/carriage-return byte inside any quoted scalar's own line.
  const fmBlock = serialized.slice(4, serialized.indexOf('\n---', 4));
  for (const line of fmBlock.split('\n')) {
    assert.ok(!/\r/.test(line), `frontmatter line must not contain a raw CR: ${JSON.stringify(line)}`);
  }
  const parsed = engine.parseRecord(serialized);
  assert.strictEqual(parsed.frontmatter.name, record.name);
  assert.strictEqual(parsed.frontmatter.description, record.description);
  assert.strictEqual(parsed.frontmatter.metadata.note, record.metadata.note);
  assert.strictEqual(parsed.frontmatter.metadata.type, record.metadata.type);
  assert.strictEqual(parsed.frontmatter.metadata.id, record.metadata.id);
});

t('BUG 1: yamlScalar quotes values a REAL YAML parser would misread as a different type or truncate', () => {
  const engine = require('../lib/memory-migrate');
  // Each of these is unquoted-safe against THIS module's own parseScalar
  // (the line-based reader never confuses them), but would be misread by a
  // real/standards-compliant YAML parser — which is exactly the reader that
  // matters for a `---` frontmatter record checked into a repo (native
  // Claude Code, any other YAML tool). Every one must come back quoted.
  const cases = [
    '[REDACTED:aws-access-key]', // real YAML: a one-element flow SEQUENCE, not a string
    'fixed issue #42', // real YAML: unquoted ` #` starts a comment -> truncates to "fixed issue"
    '{a}', // real YAML: a flow MAPPING
    '*ref', // real YAML: an alias indicator
    '&anchor', // real YAML: an anchor indicator
    '!tag value', // real YAML: a tag indicator
    '|literal', // real YAML: a block-literal indicator
    '>folded', // real YAML: a block-folded indicator
    '%directive', // real YAML: a directive indicator
    '@at', // real YAML: reserved indicator
    '`backtick', // real YAML: not a plain-scalar-safe leading char in this project's convention
    '?question', // real YAML: explicit-key indicator
    ',leading', // real YAML: leading comma is a flow-collection indicator
  ];
  for (const s of cases) {
    const serialized = engine.yamlScalar(s);
    assert.ok(
      serialized.startsWith('"') && serialized.endsWith('"'),
      `yamlScalar(${JSON.stringify(s)}) must be quoted for a real YAML reader, got: ${serialized}`
    );
    const parsed = engine.parseScalar(serialized);
    assert.strictEqual(parsed, s, `yamlScalar(${JSON.stringify(s)}) -> ${serialized} must round-trip via parseScalar to the identical string`);
  }
});

t('BUG 1: end-to-end — a fully-redacted name stays idempotent and re-reads as a string', () => {
  const engine = require('../lib/memory-migrate');
  const redactedName = '[REDACTED:aws-access-key]'; // exactly what scrubRecordFields produces for a fully-redacted name
  const record = {
    name: redactedName,
    description: `secret was here: ${redactedName}`,
    metadata: { type: 'project', scope: 'implementer', id: '44444444-4444-4444-4444-444444444444' },
    body: 'Body.\n',
  };
  const serialized = engine.serializeRecord(record);
  const nameLine = serialized.split('\n').find((l) => l.startsWith('name:'));
  assert.strictEqual(nameLine, `name: "${redactedName}"`, 'a bracket-leading name must be quoted in the serialized frontmatter');

  const parsed = engine.parseRecord(serialized);
  assert.strictEqual(typeof parsed.frontmatter.name, 'string', 'name must re-read as a string, not a YAML list');
  assert.strictEqual(parsed.frontmatter.name, redactedName);

  // Idempotency: re-serializing the parsed-back record produces byte-identical
  // frontmatter (the fix must not just fix ONE pass, it must be stable).
  const reserialized = engine.serializeRecord({
    name: parsed.frontmatter.name,
    description: parsed.frontmatter.description,
    metadata: parsed.frontmatter.metadata,
    body: parsed.body,
  });
  assert.strictEqual(reserialized, serialized, 're-serializing the parsed record must be byte-identical (idempotent)');
});

t('a literal two-character backslash-n round-trips correctly (never misread as an escaped newline)', () => {
  const engine = require('../lib/memory-migrate');
  const literal = 'path is C:\\notes\\readme and a real\nnewline too';
  const record = {
    name: 'literal-backslash-n',
    description: literal,
    metadata: { type: 'project', scope: 'implementer', id: '33333333-3333-3333-3333-333333333333' },
    body: 'Body.\n',
  };
  const serialized = engine.serializeRecord(record);
  const parsed = engine.parseRecord(serialized);
  assert.strictEqual(parsed.frontmatter.description, literal);
});

t('MEMORY.md dedup regex ignores a ](other.md) link embedded in hook prose', () => {
  const engine = require('../lib/memory-migrate');
  const dir = mkRepo();
  const scopeDir = path.join(dir, '.claude/agent-memory/forge-implementer');
  fs.mkdirSync(scopeDir, { recursive: true });
  // A pre-existing index entry whose OWN hook/description text happens to
  // contain a markdown-link-shaped substring pointing at a DIFFERENT file.
  // The dedup regex must only look at the entry's own leading link, so it
  // must not mistake "other.md" for an indexed file and must not skip
  // re-indexing "real.md" below.
  write(
    dir,
    '.claude/agent-memory/forge-implementer/MEMORY.md',
    '- [existing](existing.md) — see also [a note](other.md) for background\n'
  );
  write(
    dir,
    '.claude/agent-memory/forge-implementer/real.md',
    [
      '---',
      'name: real-record',
      'description: A real migrated record',
      'metadata:',
      '  type: project',
      '  id: 44444444-4444-4444-4444-444444444444',
      '---',
      '',
      'Body.',
      '',
    ].join('\n')
  );
  const result = engine.buildMemoryIndex(scopeDir, ['real.md']);
  assert.strictEqual(result.changed, true, 'real.md must be indexed, not skipped as a false dedup hit');
  const index = fs.readFileSync(path.join(scopeDir, 'MEMORY.md'), 'utf8');
  assert.match(index, /\(real\.md\)/);
});

// ---- regression tests: whole-diff review fixes -----------------------------

t('BUG 1: archiveOriginal never clobbers an existing archive entry — two different originals at the same archive path both survive under distinct names', () => {
  const engine = require('../lib/memory-migrate');
  const dir = mkRepo();
  const archiveDest = path.join(dir, 'archive', 'note.md');
  const srcA = write(dir, 'src-a.md', 'first original content\n');
  const usedA = engine.archiveOriginal(srcA, archiveDest);
  assert.strictEqual(usedA, archiveDest, 'first archive uses the exact requested path');
  assert.strictEqual(fs.readFileSync(archiveDest, 'utf8'), 'first original content\n');

  const srcB = write(dir, 'src-b.md', 'second original content\n');
  const usedB = engine.archiveOriginal(srcB, archiveDest);
  assert.notStrictEqual(usedB, archiveDest, 'second archive must use a non-colliding sibling path');
  assert.ok(fs.existsSync(usedB));
  // Both survive, byte-identical to their own source, neither clobbered.
  assert.strictEqual(fs.readFileSync(archiveDest, 'utf8'), 'first original content\n');
  assert.strictEqual(fs.readFileSync(usedB, 'utf8'), 'second original content\n');
});

t('BUG 1 (end to end): re-adding a note at a previously-migrated path and re-running migration does not destroy the first archived original', () => {
  const dir = buildFixture();
  run(dir); // migrates plain-lesson.md, archives it under _pre-migration/

  const archivedPath = path.join(dir, '.claude/agent-memory/_pre-migration/forge-implementer/plain-lesson.md');
  const firstArchiveContent = fs.readFileSync(archivedPath, 'utf8');
  assert.ok(firstArchiveContent.includes(SECRET), 'sanity: first archive holds the original pristine content');

  // A human deletes the migrated native record and re-adds a DIFFERENT
  // plain-markdown note at the same original path, then re-runs migration.
  const livePath = path.join(dir, '.claude/agent-memory/forge-implementer/plain-lesson.md');
  fs.writeFileSync(livePath, '# A different second note\n\nCompletely different content.\n', 'utf8');
  const r = run(dir);
  assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);

  // The FIRST archived original must be untouched, byte-identical.
  assert.strictEqual(fs.readFileSync(archivedPath, 'utf8'), firstArchiveContent, 'first archive must survive unclobbered');
  // The second original must ALSO be archived somewhere, not lost — as a
  // non-colliding SIBLING of plain-lesson.md specifically (the archive dir
  // also legitimately holds flat.md's own archive from the first run, so
  // the search must be scoped to plain-lesson's own sibling naming, not
  // "any other file in the directory").
  const archiveDir = path.join(dir, '.claude/agent-memory/_pre-migration/forge-implementer');
  const archivedNames = fs.readdirSync(archiveDir);
  const secondArchiveName = archivedNames.find((n) => /^plain-lesson\.\d+\.md$/.test(n));
  assert.ok(secondArchiveName, `a non-colliding sibling archive name must exist for the second original; found: ${archivedNames.join(', ')}`);
  assert.match(fs.readFileSync(path.join(archiveDir, secondArchiveName), 'utf8'), /Completely different content\./);
});

t('BUG 2: yamlScalar/parseScalar round-trip numeric/bool/null-LOOKING strings as the same string', () => {
  const engine = require('../lib/memory-migrate');
  for (const s of ['0001', '123', '-5', '3.14', 'null', 'true', 'false', '~', '']) {
    const serialized = engine.yamlScalar(s);
    const parsed = engine.parseScalar(serialized);
    assert.strictEqual(parsed, s, `yamlScalar(${JSON.stringify(s)}) -> ${serialized} must parse back as the string, got ${JSON.stringify(parsed)}`);
  }
});

t('BUG 2 (end to end): a record named 0001.md is idempotent — second migration run is a no-op, not re-migrated', () => {
  const dir = mkRepo();
  write(dir, '.claude/agent-memory/forge-implementer/0001.md', '# Numeric-looking slug\n\nSome content.\n');
  const r1 = run(dir);
  assert.strictEqual(r1.status, 0, `stderr: ${r1.stderr}`);
  assert.match(r1.stdout, /1 migrated, 0 skipped, 0 errored/);

  const filePath = path.join(dir, '.claude/agent-memory/forge-implementer/0001.md');
  const afterFirstRun = fs.readFileSync(filePath, 'utf8');
  const engine = require('../lib/memory-migrate');
  const parsed = engine.parseRecord(afterFirstRun);
  assert.strictEqual(typeof parsed.frontmatter.name, 'string', 'name must stay a string, not be coerced to a number');
  assert.ok(engine.isNativeRecord(parsed.frontmatter), 'must be classified native after the first run');

  const r2 = run(dir);
  assert.strictEqual(r2.status, 0, `stderr: ${r2.stderr}`);
  assert.match(r2.stdout, /0 migrated, 1 skipped, 0 errored/, 'second run must be a no-op, not re-migrate');
  assert.strictEqual(fs.readFileSync(filePath, 'utf8'), afterFirstRun, 'file must be byte-identical after the no-op second run');
});

t('BUG 3: an already-native record with CRLF line endings is detected native and left untouched', () => {
  const dir = mkRepo();
  const crlfRecord = [
    '---',
    'name: crlf-native',
    'description: Already native, CRLF line endings',
    'metadata:',
    '  type: project',
    '  id: 77777777-7777-7777-7777-777777777777',
    '---',
    '',
    'CRLF body content.',
    '',
  ].join('\r\n');
  const filePath = write(dir, '.claude/agent-memory/forge-implementer/crlf-native.md', crlfRecord);

  const engine = require('../lib/memory-migrate');
  const parsed = engine.parseRecord(crlfRecord);
  assert.ok(engine.isNativeRecord(parsed.frontmatter), 'a CRLF native record must be recognized as native by the parser directly');

  const r = run(dir);
  assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /0 migrated, 1 skipped, 0 errored/, 'CRLF native record must be skipped, not migrated');
  assert.strictEqual(fs.readFileSync(filePath, 'utf8'), crlfRecord, 'CRLF native record must not be rewritten a single byte');

  const archivedPath = path.join(dir, '.claude/agent-memory/_pre-migration/forge-implementer/crlf-native.md');
  assert.ok(!fs.existsSync(archivedPath), 'a native record (CRLF or not) must never be archived');
});

t('SECURITY: a secret in a pre-existing MEMORY.md does not survive into the rewritten index', () => {
  const dir = buildFixture();
  const indexPath = path.join(dir, '.claude/agent-memory/forge-implementer/MEMORY.md');
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(indexPath, `- [old note](old.md) — pre-existing entry with a leaked key ${SECRET}\n`, 'utf8');

  const r = run(dir);
  assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
  const index = fs.readFileSync(indexPath, 'utf8');
  assert.ok(!index.includes(SECRET), 'secret from a pre-existing MEMORY.md line must not survive into the rewritten index');
  assert.match(index, /\[REDACTED:aws-access-key\]/);
});

t('SECURITY: a secret in an already-native record\'s description does not survive into the index', () => {
  const dir = mkRepo();
  write(
    dir,
    '.claude/agent-memory/forge-implementer/native-with-secret.md',
    [
      '---',
      'name: native-with-secret',
      `description: Has a secret ${SECRET} in the description`,
      'metadata:',
      '  type: project',
      '  id: 88888888-8888-8888-8888-888888888888',
      '---',
      '',
      'Body.',
      '',
    ].join('\n')
  );
  const r = run(dir);
  assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
  const indexPath = path.join(dir, '.claude/agent-memory/forge-implementer/MEMORY.md');
  assert.ok(fs.existsSync(indexPath), 'index must be created since a native record needs indexing');
  const index = fs.readFileSync(indexPath, 'utf8');
  assert.ok(!index.includes(SECRET), 'secret from an already-native record\'s description must not survive into the index');
  assert.match(index, /\[REDACTED:aws-access-key\]/);

  // The native record file itself is untouched (still holds the raw
  // secret) — only the INDEX write is scrubbed, matching the Bluegrass
  // rule that an already-native record is never rewritten.
  const nativeRaw = fs.readFileSync(
    path.join(dir, '.claude/agent-memory/forge-implementer/native-with-secret.md'),
    'utf8'
  );
  assert.ok(nativeRaw.includes(SECRET), 'the native record itself must remain byte-identical (not rewritten)');

  // SECURITY 3: this redaction's raw secret was NEVER archived (the native
  // record was left untouched by design) — the closing WARNING must name
  // the LIVE record path, not the (nonexistent, for this file) archive.
  assert.match(r.stdout, /WARNING/);
  assert.match(
    r.stdout,
    /forge-implementer[/\\]native-with-secret\.md/,
    `WARNING must name the live record path, got: ${r.stdout}`
  );
  assert.ok(
    !/_pre-migration/.test(r.stdout),
    `no record was archived in this run — WARNING must not point at _pre-migration/, got: ${r.stdout}`
  );
});

t('BUG 4: a pre-existing hub with internal blank lines keeps them after a migration run', () => {
  const dir = buildFixture();
  const indexPath = path.join(dir, '.claude/agent-memory/forge-implementer/MEMORY.md');
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  const existingContent = '# Memory Hub\n\n- [old note](old.md) — an existing entry\n\n## Section two\n\nSome prose.\n';
  fs.writeFileSync(indexPath, existingContent, 'utf8');

  const r = run(dir);
  assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
  const index = fs.readFileSync(indexPath, 'utf8');
  assert.match(index, /# Memory Hub\n\n- \[old note\]\(old\.md\) — an existing entry\n\n## Section two\n\nSome prose\./, 'internal blank lines and structure must be preserved verbatim');
});

t('BUG 5: an unreadable file is reported as a per-file error and the OTHER scopes still migrate', () => {
  const dir = buildFixture();
  const unreadablePath = write(dir, '.claude/agent-memory/forge-unreadable/secret.md', '# Cannot read this\n');
  fs.chmodSync(unreadablePath, 0o000);
  try {
    const r = run(dir);
    // Root may still run as a privileged user in some CI sandboxes where
    // chmod 000 doesn't actually block reads; only assert the strong
    // per-scope-resilience claim when the read genuinely failed.
    let readBlocked = true;
    try {
      fs.readFileSync(unreadablePath, 'utf8');
      readBlocked = false;
    } catch (e) {
      readBlocked = true;
    }
    if (readBlocked) {
      assert.strictEqual(r.status, 1, `expected non-zero exit due to the unreadable-file error; stderr: ${r.stderr}`);
      assert.match(r.stderr, /ERROR forge-unreadable[/\\]secret\.md:/);
    }
    // Regardless, the other (good) scope must still have migrated.
    const engine = require('../lib/memory-migrate');
    const plainPath = path.join(dir, '.claude/agent-memory/forge-implementer/plain-lesson.md');
    const plainParsed = engine.parseRecord(fs.readFileSync(plainPath, 'utf8'));
    assert.ok(engine.isNativeRecord(plainParsed.frontmatter), 'other scopes must still migrate despite an unreadable file elsewhere');
  } finally {
    fs.chmodSync(unreadablePath, 0o644);
  }
});

t('BUG 5: an oversize file is reported as a per-file error and the OTHER scopes still migrate', () => {
  const dir = buildFixture();
  const engine = require('../lib/memory-migrate');
  const big = 'x'.repeat(engine.MAX_RECORD_BYTES + 1024);
  write(dir, '.claude/agent-memory/forge-oversize/big.md', big);

  const r = run(dir);
  assert.strictEqual(r.status, 1, `expected non-zero exit due to the oversize-file error; stderr: ${r.stderr}`);
  assert.match(r.stderr, /ERROR forge-oversize[/\\]big\.md:.*too large/);

  // The oversize file is left completely untouched (never archived, never
  // rewritten) since it was rejected before any read/migration attempt.
  const bigPath = path.join(dir, '.claude/agent-memory/forge-oversize/big.md');
  assert.strictEqual(fs.readFileSync(bigPath, 'utf8'), big);
  const archivedBig = path.join(dir, '.claude/agent-memory/_pre-migration/forge-oversize/big.md');
  assert.ok(!fs.existsSync(archivedBig), 'an oversize file must never be archived');

  // Other scopes still migrate.
  const plainPath = path.join(dir, '.claude/agent-memory/forge-implementer/plain-lesson.md');
  const plainParsed = engine.parseRecord(fs.readFileSync(plainPath, 'utf8'));
  assert.ok(engine.isNativeRecord(plainParsed.frontmatter), 'other scopes must still migrate despite an oversize file elsewhere');
});

t('BUG 6: --root with no following value exits non-zero and writes nothing', () => {
  const dir = buildFixture();
  const before = fs.readFileSync(path.join(dir, '.claude/agent-memory/forge-implementer/plain-lesson.md'), 'utf8');
  // Simulate `--root` as the LAST argument (no value follows).
  const r = spawnSync(process.execPath, [CLI, '--root'], { encoding: 'utf8', cwd: dir });
  assert.notStrictEqual(r.status, 0, 'must exit non-zero rather than silently defaulting to cwd');
  assert.match(r.stderr, /--root requires/);
  const after = fs.readFileSync(path.join(dir, '.claude/agent-memory/forge-implementer/plain-lesson.md'), 'utf8');
  assert.strictEqual(after, before, 'nothing in the accidental cwd target must be written');
});

t('BUG 6: --root <nonexistent> still errors (existing behavior preserved)', () => {
  const dir = mkRepo();
  const nonexistent = path.join(dir, 'does-not-exist');
  const r = spawnSync(process.execPath, [CLI, '--root', nonexistent], { encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0, 'a nonexistent --root target must still error');
  assert.match(r.stderr, /does not exist/);
});

t('BUG 6: --root followed by a flag-shaped value (no value given) exits non-zero', () => {
  const dir = buildFixture();
  const r = spawnSync(process.execPath, [CLI, '--root', '--dry-run'], { encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0, 'a flag-shaped value must not be silently accepted as the root path');
  assert.match(r.stderr, /--root requires/);
});

t('SUGGESTION: a run that redacted a secret prints a closing WARNING pointing at _pre-migration/', () => {
  const dir = buildFixture();
  const r = run(dir);
  assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /WARNING/);
  assert.match(r.stdout, /_pre-migration/);
});

t('a run with no secrets does not print the redaction WARNING', () => {
  const dir = mkRepo();
  write(
    dir,
    '.claude/agent-memory/forge-implementer/clean.md',
    '# A clean note\n\nNothing sensitive here.\n'
  );
  const r = run(dir);
  assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
  assert.ok(!/WARNING/.test(r.stdout), 'no WARNING should print when nothing was redacted');
});

// ---- regression test: index-link corruption from the index-scrub ----------

t('BUG 7: buildMemoryIndex keeps a resolvable link target for a secret-shaped filename, while the record\'s own title/hook text is scrubbed', () => {
  const engine = require('../lib/memory-migrate');
  const dir = mkRepo();
  const scopeDir = path.join(dir, '.claude/agent-memory/forge-implementer');
  fs.mkdirSync(scopeDir, { recursive: true });
  // The on-disk record's basename is shaped exactly like an AWS access key
  // id (e.g. because slugFromFilename/the caller preserved the original
  // basename per the "links/paths already pointing at it stay valid"
  // contract). Its own frontmatter name/description ALSO carry the secret
  // verbatim (unlike the lower-cased-slug case, a record can legitimately
  // have a case-preserved name from a pre-existing `name:` field). Before
  // the fix, scrubbing the WHOLE assembled index markdown would rewrite
  // this link's TARGET (the filename) into a [REDACTED:...] token, leaving
  // the real on-disk record unlinked/invisible while the index pointed at
  // a file that doesn't exist.
  const fileName = `${SECRET}.md`;
  write(
    dir,
    `.claude/agent-memory/forge-implementer/${fileName}`,
    [
      '---',
      `name: ${SECRET}`,
      `description: leaked key ${SECRET} in this record`,
      'metadata:',
      '  type: project',
      '  id: 66666666-6666-6666-6666-666666666666',
      '---',
      '',
      'Body.',
      '',
    ].join('\n')
  );
  const result = engine.buildMemoryIndex(scopeDir, [fileName]);
  assert.strictEqual(result.changed, true);
  assert.ok(result.redactions >= 1, 'the secret in title/hook must be counted as a redaction');

  const index = fs.readFileSync(path.join(scopeDir, 'MEMORY.md'), 'utf8');
  const m = /^-\s*\[(.*)\]\(([^)]+\.md)\)\s*—\s*(.*)$/m.exec(index);
  assert.ok(m, `index must contain a well-formed entry line, got: ${index}`);
  const [, title, target, hook] = m;
  assert.strictEqual(target, fileName, 'index link target must point at the real on-disk record filename, unscrubbed');
  assert.ok(fs.existsSync(path.join(scopeDir, target)), 'the linked target file must actually exist');
  assert.ok(!title.includes(SECRET), 'title text must be scrubbed');
  assert.ok(!hook.includes(SECRET), 'hook text must be scrubbed');
});

t('BUG 7: a pre-existing hub line with a secret in its hook is scrubbed while its link target is preserved', () => {
  const engine = require('../lib/memory-migrate');
  const dir = mkRepo();
  const scopeDir = path.join(dir, '.claude/agent-memory/forge-implementer');
  fs.mkdirSync(scopeDir, { recursive: true });
  write(
    dir,
    '.claude/agent-memory/forge-implementer/MEMORY.md',
    `- [existing-note](existing.md) — leaked key ${SECRET} in this hook\n`
  );
  write(
    dir,
    '.claude/agent-memory/forge-implementer/real.md',
    [
      '---',
      'name: real-record',
      'description: A real migrated record',
      'metadata:',
      '  type: project',
      '  id: 55555555-5555-5555-5555-555555555555',
      '---',
      '',
      'Body.',
      '',
    ].join('\n')
  );
  const result = engine.buildMemoryIndex(scopeDir, ['real.md']);
  assert.strictEqual(result.changed, true);
  assert.ok(result.redactions >= 1, 'the pre-existing line secret must be counted as a redaction');
  const index = fs.readFileSync(path.join(scopeDir, 'MEMORY.md'), 'utf8');
  assert.match(index, /\(existing\.md\)/, 'pre-existing entry link target must be preserved, not rewritten');
  assert.ok(!index.includes(SECRET), 'the secret must not survive in the rewritten index');
});

t('BUG 2: a pre-existing hub line with a link but NO hook at all keeps its link target', () => {
  const engine = require('../lib/memory-migrate');
  const dir = mkRepo();
  const scopeDir = path.join(dir, '.claude/agent-memory/forge-implementer');
  fs.mkdirSync(scopeDir, { recursive: true });
  // No ` — hook` suffix whatsoever — just `- [title](target.md)`. Before the
  // fix, the carry-through scrub regex required a trailing `) — hook` and
  // fell through to the whole-line scrubSecrets branch for a line like this,
  // which (for a secret-shaped target) would corrupt the link target itself.
  const secretFileName = `${SECRET}.md`;
  write(dir, `.claude/agent-memory/forge-implementer/${secretFileName}`, 'placeholder');
  write(dir, '.claude/agent-memory/forge-implementer/MEMORY.md', `- [a title](${secretFileName})\n`);
  write(
    dir,
    '.claude/agent-memory/forge-implementer/real.md',
    [
      '---',
      'name: real-record',
      'description: A real migrated record',
      'metadata:',
      '  type: project',
      '  id: 77777777-7777-7777-7777-777777777777',
      '---',
      '',
      'Body.',
      '',
    ].join('\n')
  );
  const result = engine.buildMemoryIndex(scopeDir, ['real.md']);
  assert.strictEqual(result.changed, true);
  const index = fs.readFileSync(path.join(scopeDir, 'MEMORY.md'), 'utf8');
  assert.match(
    index,
    new RegExp(`\\(${SECRET}\\.md\\)`),
    `link target must be preserved unscrubbed even with no hook suffix, got: ${index}`
  );
});

t('BUG 2: a pre-existing hub line using a non-em-dash separator scrubs the hook but keeps the link target', () => {
  const engine = require('../lib/memory-migrate');
  const dir = mkRepo();
  const scopeDir = path.join(dir, '.claude/agent-memory/forge-implementer');
  fs.mkdirSync(scopeDir, { recursive: true });
  write(
    dir,
    '.claude/agent-memory/forge-implementer/MEMORY.md',
    `- [existing-note](existing.md) - leaked key ${SECRET} in this hook\n`
  );
  write(
    dir,
    '.claude/agent-memory/forge-implementer/real.md',
    [
      '---',
      'name: real-record',
      'description: A real migrated record',
      'metadata:',
      '  type: project',
      '  id: 99999999-9999-9999-9999-999999999999',
      '---',
      '',
      'Body.',
      '',
    ].join('\n')
  );
  const result = engine.buildMemoryIndex(scopeDir, ['real.md']);
  assert.strictEqual(result.changed, true);
  assert.ok(result.redactions >= 1, 'the pre-existing line secret must still be counted as a redaction');
  const index = fs.readFileSync(path.join(scopeDir, 'MEMORY.md'), 'utf8');
  assert.match(index, /\(existing\.md\)/, 'pre-existing entry link target must be preserved with a non-em-dash separator too');
  assert.ok(!index.includes(SECRET), 'the secret must not survive in the rewritten index');
});

console.log(`\n${ran - failed}/${ran} passed`);
process.exit(failed ? 1 : 0);
