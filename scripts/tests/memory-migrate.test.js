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

console.log(`\n${ran - failed}/${ran} passed`);
process.exit(failed ? 1 : 0);
