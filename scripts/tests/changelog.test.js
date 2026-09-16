#!/usr/bin/env node
// Tests for the changelog tooling's containment, symlink and crash-safety
// guarantees. Plain Node asserts, no dependencies (D11). Each case builds a
// throwaway repo under os.tmpdir() and points the scripts at it with
// FORGE_REPO_ROOT, so nothing here touches the real changelog.d/.
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..');
const { listFragmentFiles, parseFragment, resolveInside } = require('../lib/changelog-fragment');

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures += 1;
    console.error(`  FAIL ${name}: ${e.message}`);
  }
}

function tmpRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-changelog-'));
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(root, 'changelog.d'), { recursive: true });
  fs.writeFileSync(path.join(root, 'changelog.d', 'README.md'), '# changelog.d\n');
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), '# Changelog\n\n## 2026-01-01\n\n### Added\n- old\n');
  return root;
}
function writeConfig(root, cfg) {
  fs.writeFileSync(path.join(root, '.claude', 'forge.json'), JSON.stringify(cfg));
}
function run(script, root) {
  return spawnSync('node', [path.join(SCRIPTS, script)], {
    encoding: 'utf8',
    env: { ...process.env, FORGE_REPO_ROOT: root },
  });
}

console.log('resolveInside:');

test('accepts the defaults and nested repo-relative paths', () => {
  const root = tmpRepo();
  assert.strictEqual(resolveInside(root, 'changelog.d', 'k'), path.join(root, 'changelog.d'));
  assert.strictEqual(resolveInside(root, 'docs/changes', 'k'), path.join(root, 'docs', 'changes'));
  assert.strictEqual(resolveInside(root, '.', 'k'), root);
});

test('rejects ../ traversal, absolute paths, and non-strings', () => {
  const root = tmpRepo();
  assert.throws(() => resolveInside(root, '../../outside', 'k'), /must stay inside/);
  assert.throws(() => resolveInside(root, 'changelog.d/../../x', 'k'), /must stay inside/);
  assert.throws(() => resolveInside(root, '/etc', 'k'), /must stay inside/);
  assert.throws(() => resolveInside(root, '', 'k'), /non-empty string/);
  assert.throws(() => resolveInside(root, 42, 'k'), /non-empty string/);
  assert.throws(() => resolveInside(root, undefined, 'k'), /non-empty string/);
});

test('a sibling directory that merely shares the root as a prefix is outside', () => {
  const root = tmpRepo();
  // /tmp/forge-changelog-abc vs /tmp/forge-changelog-abc-evil: startsWith
  // without the separator would accept the second.
  assert.throws(() => resolveInside(root, `../${path.basename(root)}-evil`, 'k'), /must stay inside/);
});

console.log('listFragmentFiles / parseFragment:');

test('lists regular *.md fragments, ignores README and non-.md entries', () => {
  const root = tmpRepo();
  const dir = path.join(root, 'changelog.d');
  fs.writeFileSync(path.join(dir, 'b.md'), 'section: Added\n- b\n');
  fs.writeFileSync(path.join(dir, 'a.md'), 'section: Added\n- a\n');
  fs.mkdirSync(path.join(dir, '.closeout-staging'));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
  assert.deepStrictEqual(
    listFragmentFiles(dir).map((f) => path.basename(f)),
    ['a.md', 'b.md'],
  );
});

test('a symlinked *.md fragment is a hard error, not a silent read', () => {
  const root = tmpRepo();
  const dir = path.join(root, 'changelog.d');
  const secret = path.join(root, 'secret.txt');
  fs.writeFileSync(secret, 'TOKEN=hunter2\n');
  fs.symlinkSync(secret, path.join(dir, 'leak.md'));
  assert.throws(() => listFragmentFiles(dir), /leak\.md is a symlink/);
  assert.throws(() => parseFragment(path.join(dir, 'leak.md'), root), /is a symlink/);
});

test('a directory named *.md is a hard error too', () => {
  const root = tmpRepo();
  fs.mkdirSync(path.join(root, 'changelog.d', 'weird.md'));
  assert.throws(() => listFragmentFiles(path.join(root, 'changelog.d')), /is a directory/);
});

console.log('symlink containment (physical, not just lexical):');

test('a fragmentsDir that is a committed symlink to OUTSIDE the repo is refused', () => {
  const root = tmpRepo();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-outside-'));
  fs.writeFileSync(path.join(outside, 'victim.md'), 'section: Added\n- from outside\n');
  fs.mkdirSync(path.join(root, 'docs'));
  fs.symlinkSync(outside, path.join(root, 'docs', 'out'));
  // Lexically "docs/out" is inside the repo. Physically it is not.
  assert.throws(() => resolveInside(root, 'docs/out', 'changelog.fragmentsDir'), /through a symlink/);
});

test('the fragments directory itself being a symlink is a hard error', () => {
  const root = tmpRepo();
  const real = path.join(root, 'real-frags');
  fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, 'a.md'), 'section: Added\n- a\n');
  fs.rmSync(path.join(root, 'changelog.d'), { recursive: true });
  fs.symlinkSync(real, path.join(root, 'changelog.d'));
  assert.throws(() => listFragmentFiles(path.join(root, 'changelog.d'), root), /is a symlink; the fragments directory/);
});

test('error messages are repo-relative, never absolute runner paths', () => {
  const root = tmpRepo();
  fs.symlinkSync(path.join(root, 'CHANGELOG.md'), path.join(root, 'changelog.d', 'leak.md'));
  let msg = '';
  try { listFragmentFiles(path.join(root, 'changelog.d'), root); } catch (e) { msg = e.message; }
  assert.match(msg, /^changelog\.d\/leak\.md is a symlink/);
  assert.doesNotMatch(msg, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

console.log('validate-changelog.js end to end:');

test('a traversal fragmentsDir in forge.json is refused with exit 1', () => {
  const root = tmpRepo();
  writeConfig(root, { changelog: { fragmentsDir: '../../../../etc' } });
  const r = run('validate-changelog.js', root);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /must stay inside the repository/);
});

test('a symlinked fragment fails validation instead of leaking its target', () => {
  const root = tmpRepo();
  fs.writeFileSync(path.join(root, 'secret.txt'), 'TOKEN=hunter2\n');
  fs.symlinkSync(path.join(root, 'secret.txt'), path.join(root, 'changelog.d', 'leak.md'));
  const r = run('validate-changelog.js', root);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /is a symlink/);
  assert.doesNotMatch(r.stdout + r.stderr, /hunter2/, 'target content must never be echoed');
});

test('valid fragments still pass', () => {
  const root = tmpRepo();
  fs.writeFileSync(path.join(root, 'changelog.d', 'x.md'), 'section: Added\n- thing\n');
  const r = run('validate-changelog.js', root);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /1 fragment\(s\) valid/);
});

console.log('changelog-closeout.js end to end:');

test('a traversal changelog.file is refused before anything is touched', () => {
  const root = tmpRepo();
  fs.writeFileSync(path.join(root, 'changelog.d', 'x.md'), 'section: Added\n- thing\n');
  writeConfig(root, { changelog: { file: '../../outside.md' } });
  const r = run('changelog-closeout.js', root);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /changelog\.file must stay inside/);
  assert.ok(fs.existsSync(path.join(root, 'changelog.d', 'x.md')), 'fragment must be untouched');
});

test('happy path: assembles, deletes fragments, leaves no staging dir', () => {
  const root = tmpRepo();
  fs.writeFileSync(path.join(root, 'changelog.d', 'x.md'), 'section: Added\n- new thing\n');
  const r = run('changelog-closeout.js', root);
  assert.strictEqual(r.status, 0, r.stderr);
  const cl = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  assert.match(cl, /new thing/);
  assert.match(cl, /- old/, 'previous content preserved');
  assert.ok(!fs.existsSync(path.join(root, 'changelog.d', 'x.md')), 'fragment consumed');
  assert.ok(!fs.existsSync(path.join(root, 'changelog.d', '.closeout-staging')), 'staging cleaned');
  assert.strictEqual(fs.readdirSync(root).filter((n) => n.startsWith('CHANGELOG.md.tmp')).length, 0, 'no temp file left');
});

test('a leftover staging dir from an interrupted run blocks the next run', () => {
  const root = tmpRepo();
  const staging = path.join(root, 'changelog.d', '.closeout-staging');
  fs.mkdirSync(staging);
  fs.writeFileSync(path.join(staging, 'orphan.md'), 'section: Added\n- already published?\n');
  const before = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  // No live fragment on purpose: the interruption this guards leaves none.
  const r = run('changelog-closeout.js', root);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /previous close-out was interrupted/);
  assert.doesNotMatch(r.stderr + r.stdout, /nothing to assemble/, 'must not be misreported as empty');
  assert.strictEqual(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), before, 'changelog untouched');
});

test('fragmentsDir symlinked outside the repo: close-out refuses, deletes nothing', () => {
  const root = tmpRepo();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-outside-'));
  fs.writeFileSync(path.join(outside, 'victim.md'), 'section: Added\n- from outside\n');
  fs.mkdirSync(path.join(root, 'docs'));
  fs.symlinkSync(outside, path.join(root, 'docs', 'out'));
  writeConfig(root, { changelog: { fragmentsDir: 'docs/out' } });
  const r = run('changelog-closeout.js', root);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /through a symlink/);
  assert.ok(fs.existsSync(path.join(outside, 'victim.md')), 'the outside file must survive');
});

test('a symlinked CHANGELOG.md is refused before any fragment moves', () => {
  const root = tmpRepo();
  const outside = path.join(os.tmpdir(), `forge-outside-cl-${process.pid}.md`);
  fs.writeFileSync(outside, '# secret notes\n');
  fs.unlinkSync(path.join(root, 'CHANGELOG.md'));
  fs.symlinkSync(outside, path.join(root, 'CHANGELOG.md'));
  fs.writeFileSync(path.join(root, 'changelog.d', 'x.md'), 'section: Added\n- x\n');
  const r = run('changelog-closeout.js', root);
  assert.strictEqual(r.status, 1);
  // Refused at config resolution (realpath escapes the repo) — earlier than
  // the lstat check, and the better place for it.
  assert.match(r.stderr, /through a symlink|is a symlink; changelog\.file/);
  assert.ok(fs.existsSync(path.join(root, 'changelog.d', 'x.md')), 'fragment untouched');
  assert.strictEqual(fs.readFileSync(outside, 'utf8'), '# secret notes\n', 'link target untouched');
  fs.unlinkSync(outside);
});

test('a symlinked fragment makes close-out exit 1 with an error line, not a stack trace', () => {
  const root = tmpRepo();
  fs.symlinkSync(path.join(root, 'CHANGELOG.md'), path.join(root, 'changelog.d', 'leak.md'));
  const r = run('changelog-closeout.js', root);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /^error: changelog\.d\/leak\.md is a symlink/m);
  assert.doesNotMatch(r.stderr, /at .*\(.*:\d+:\d+\)/, 'no stack trace');
});

test('a stray FILE named .closeout-staging gives an error line, not ENOTDIR', () => {
  const root = tmpRepo();
  fs.writeFileSync(path.join(root, 'changelog.d', '.closeout-staging'), 'oops');
  fs.writeFileSync(path.join(root, 'changelog.d', 'x.md'), 'section: Added\n- x\n');
  const r = run('changelog-closeout.js', root);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /exists but is not a directory/);
  assert.doesNotMatch(r.stderr, /ENOTDIR|EEXIST/);
});

test('a directory where CHANGELOG.md should be gives an error line, not EISDIR', () => {
  const root = tmpRepo();
  fs.unlinkSync(path.join(root, 'CHANGELOG.md'));
  fs.mkdirSync(path.join(root, 'CHANGELOG.md'));
  fs.writeFileSync(path.join(root, 'changelog.d', 'x.md'), 'section: Added\n- x\n');
  const r = run('changelog-closeout.js', root);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /exists but is not a regular file/);
  assert.doesNotMatch(r.stderr, /EISDIR/);
  assert.ok(fs.existsSync(path.join(root, 'changelog.d', 'x.md')), 'fragment untouched');
});

test('a failed publish removes its temp file and restores fragments', () => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    console.log('       (skipped: running as root, read-only dirs are not enforced)');
    return;
  }
  const root = tmpRepo();
  fs.writeFileSync(path.join(root, 'changelog.d', 'x.md'), 'section: Added\n- x\n');
  // Fragments stage fine (changelog.d/ stays writable); the temp changelog
  // write in the read-only root fails AFTER staging, which is the path under
  // test.
  fs.chmodSync(root, 0o555);
  let r;
  try {
    r = run('changelog-closeout.js', root);
  } finally {
    fs.chmodSync(root, 0o755);
  }
  assert.strictEqual(r.status, 1, r.stderr);
  assert.match(r.stderr, /failed before publishing, fragments restored/);
  assert.ok(fs.existsSync(path.join(root, 'changelog.d', 'x.md')), 'fragment restored');
  assert.strictEqual(fs.readdirSync(root).filter((n) => n.startsWith('CHANGELOG.md.tmp')).length, 0, 'temp removed');
  assert.ok(!fs.existsSync(path.join(root, 'changelog.d', '.closeout-staging')), 'staging removed');
  assert.match(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), /- old/, 'changelog unchanged');
});

test('a committed symlink at the temp path is refused, not written through', () => {
  const root = tmpRepo();
  const outside = path.join(os.tmpdir(), `forge-outside-tmp-${process.pid}.md`);
  fs.writeFileSync(outside, 'DO NOT OVERWRITE\n');
  fs.symlinkSync(outside, path.join(root, 'CHANGELOG.md.tmp'));
  fs.writeFileSync(path.join(root, 'changelog.d', 'x.md'), 'section: Added\n- x\n');
  const r = run('changelog-closeout.js', root);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /failed before publishing, fragments restored: EEXIST/);
  assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'DO NOT OVERWRITE\n', 'link target untouched');
  assert.ok(fs.lstatSync(path.join(root, 'CHANGELOG.md.tmp')).isSymbolicLink(), 'the foreign path is left for the operator');
  assert.ok(fs.lstatSync(path.join(root, 'CHANGELOG.md')).isFile(), 'CHANGELOG.md is still a regular file');
  assert.ok(fs.existsSync(path.join(root, 'changelog.d', 'x.md')), 'fragment restored');
  fs.unlinkSync(outside);
});

test('a leftover staging dir WITH the PUBLISHED marker reports the known answer', () => {
  const root = tmpRepo();
  const staging = path.join(root, 'changelog.d', '.closeout-staging');
  fs.mkdirSync(staging);
  fs.writeFileSync(path.join(staging, 'done.md'), 'section: Added\n- done\n');
  fs.writeFileSync(path.join(staging, 'PUBLISHED'), '2026-01-01\n');
  // No live fragment on purpose: the interruption this guards leaves none.
  const r = run('changelog-closeout.js', root);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /changelog write DID succeed/);
});

test('rerunning after a success does not duplicate (nothing left to assemble)', () => {
  const root = tmpRepo();
  fs.writeFileSync(path.join(root, 'changelog.d', 'x.md'), 'section: Added\n- once\n');
  assert.strictEqual(run('changelog-closeout.js', root).status, 0);
  const r2 = run('changelog-closeout.js', root);
  assert.notStrictEqual(r2.status, 0, 'second run must refuse: zero fragments');
  const cl = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  assert.strictEqual((cl.match(/- once/g) || []).length, 1);
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nall changelog tests passed');
