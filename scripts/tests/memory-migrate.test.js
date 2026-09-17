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

console.log(`\n${ran - failed}/${ran} passed`);
process.exit(failed ? 1 : 0);
