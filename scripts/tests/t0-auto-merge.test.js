#!/usr/bin/env node
// Tests for scripts/t0-auto-merge.js's decision pieces. This script decides
// whether a PR may skip the human-merge marker, so every branch of the
// revoke logic is pinned here against a stub `gh` rather than trusted from
// its comments. Plain Node asserts, no dependencies (D11).
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A stub `gh` on PATH, steered per case through env vars. The module under
// test spawns `gh` by name, so this is all it takes — no monkey-patching.
const STUB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-gh-stub-'));
const STUB_LOG = path.join(STUB_DIR, 'calls.log');
fs.writeFileSync(path.join(STUB_DIR, 'gh'), `#!/usr/bin/env node
const a = process.argv.slice(2), fs = require('fs');
fs.appendFileSync(process.env.STUB_LOG, a.join(' ') + '\\n');
if (a[0] === 'pr' && a[1] === 'view') {
  // STUB_VIEW: "ok" | "fail" | "fail-once" (fails the first call only)
  const mode = process.env.STUB_VIEW || 'ok';
  if (mode === 'fail') process.exit(1);
  if (mode === 'fail-once') {
    const flag = process.env.STUB_LOG + '.once';
    if (!fs.existsSync(flag)) { fs.writeFileSync(flag, ''); process.exit(1); }
  }
  // STUB_BY: "" => not enabled; "<login>" => enabled by that login;
  // "__nologin__" => enabled but enabledBy carries no login
  const by = process.env.STUB_BY || '';
  let req = null;
  if (by === '__nologin__') req = { enabledAt: '2026-01-01T00:00:00Z', enabledBy: {} };
  else if (by) req = { enabledAt: '2026-01-01T00:00:00Z', enabledBy: { login: by } };
  process.stdout.write(JSON.stringify({ autoMergeRequest: req }) + '\\n');
  process.exit(0);
}
if (a[0] === 'pr' && a[1] === 'merge' && a.includes('--disable-auto')) {
  process.exit(process.env.STUB_DISABLE_FAIL ? 1 : 0);
}
if (a[0] === 'api' && /\\/branches\\//.test(a[1] || '')) {
  // STUB_BRANCH: unset/"fail" => gh non-zero; "garbage" => 0 but unparseable
  // stdout; anything else is written verbatim as the JSON payload body.
  const mode = process.env.STUB_BRANCH;
  if (mode === undefined || mode === 'fail') process.exit(1);
  if (mode === 'garbage') { process.stdout.write('{ not json'); process.exit(0); }
  process.stdout.write(mode + '\\n');
  process.exit(0);
}
process.exit(1);
`);
fs.chmodSync(path.join(STUB_DIR, 'gh'), 0o755);
process.env.PATH = `${STUB_DIR}${path.delimiter}${process.env.PATH}`;
process.env.STUB_LOG = STUB_LOG;

const m = require('../t0-auto-merge.js');

let failures = 0;
function test(name, fn) {
  // Each case starts clean: no prior exit code, no prior stub state.
  process.exitCode = 0;
  for (const k of ['STUB_VIEW', 'STUB_BY', 'STUB_DISABLE_FAIL', 'STUB_BRANCH', 'GITHUB_REPOSITORY']) delete process.env[k];
  try { fs.unlinkSync(`${STUB_LOG}.once`); } catch (_) { /* absent */ }
  fs.writeFileSync(STUB_LOG, '');
  // Capture log lines so assertions can check what was said.
  const said = [];
  const origLog = console.log;
  console.log = (...a) => said.push(a.join(' '));
  try {
    fn(said);
    origLog(`  ok  ${name}`);
  } catch (e) {
    failures += 1;
    origLog(`  FAIL ${name}: ${e.message}`);
  } finally {
    console.log = origLog;
  }
}
const calls = () => fs.readFileSync(STUB_LOG, 'utf8');
const disabled = () => /--disable-auto/.test(calls());

console.log('isOurGrant:');

test('recognises both spellings of the Actions app login', () => {
  assert.strictEqual(m.isOurGrant('github-actions'), true);
  assert.strictEqual(m.isOurGrant('github-actions[bot]'), true);
});

test('does not recognise a person, null, undefined, or a look-alike', () => {
  assert.strictEqual(m.isOurGrant('kivers08'), false);
  assert.strictEqual(m.isOurGrant(null), false);
  assert.strictEqual(m.isOurGrant(undefined), false);
  assert.strictEqual(m.isOurGrant('github-actions-bot'), false);
  assert.strictEqual(m.isOurGrant('my-github-actions'), false);
});

console.log('autoMergeState:');

test('not enabled => { enabled: false, by: null }', () => {
  assert.deepStrictEqual(m.autoMergeState(1), { enabled: false, by: null });
});

test('enabled by a login => { enabled: true, by }', () => {
  process.env.STUB_BY = 'github-actions';
  assert.deepStrictEqual(m.autoMergeState(1), { enabled: true, by: 'github-actions' });
});

test('enabled with no login => { enabled: true, by: null }', () => {
  process.env.STUB_BY = '__nologin__';
  assert.deepStrictEqual(m.autoMergeState(1), { enabled: true, by: null });
});

test('gh failure => { enabled: null, by: null }', () => {
  process.env.STUB_VIEW = 'fail';
  assert.deepStrictEqual(m.autoMergeState(1), { enabled: null, by: null });
});

console.log('revokeAutoMergeIfEnabled:');

test('not enabled: no disable call, job stays green', () => {
  m.revokeAutoMergeIfEnabled(1, 't');
  assert.strictEqual(disabled(), false);
  assert.strictEqual(process.exitCode || 0, 0);
});

test('our own grant (github-actions[bot]): disabled, green', () => {
  process.env.STUB_BY = 'github-actions[bot]';
  m.revokeAutoMergeIfEnabled(1, 't');
  assert.strictEqual(disabled(), true);
  assert.strictEqual(process.exitCode || 0, 0);
});

test("a person's grant: LEFT ALONE, no disable call, green, and says so", (said) => {
  process.env.STUB_BY = 'kivers08';
  m.revokeAutoMergeIfEnabled(1, 't');
  assert.strictEqual(disabled(), false, 'must never revoke a human opt-in');
  assert.strictEqual(process.exitCode || 0, 0);
  assert.ok(said.some((l) => /enabled by kivers08.*left alone/.test(l)), said.join('\n'));
});

test('enabled but enabler unknown: NOT left alone — warning, red, no blind disable', (said) => {
  process.env.STUB_BY = '__nologin__';
  m.revokeAutoMergeIfEnabled(1, 't');
  assert.strictEqual(disabled(), false, 'attribution is unknown, so no blind revoke either');
  assert.strictEqual(process.exitCode, 1);
  assert.ok(said.some((l) => /WARNING/.test(l) && /enabler could not be read/.test(l)), said.join('\n'));
});

test('state unreadable twice: warning, red, no disable call', (said) => {
  process.env.STUB_VIEW = 'fail';
  m.revokeAutoMergeIfEnabled(1, 't');
  assert.strictEqual(disabled(), false);
  assert.strictEqual(process.exitCode, 1);
  assert.ok(said.some((l) => /WARNING/.test(l) && /unreadable/.test(l)), said.join('\n'));
});

test('state unreadable ONCE then not enabled: retry succeeds, green, no disable', () => {
  process.env.STUB_VIEW = 'fail-once';
  m.revokeAutoMergeIfEnabled(1, 't');
  assert.strictEqual(disabled(), false);
  assert.strictEqual(process.exitCode || 0, 0);
  assert.strictEqual((calls().match(/pr view/g) || []).length, 2, 'exactly one retry');
});

test('our grant but the disable fails: warning, red', (said) => {
  process.env.STUB_BY = 'github-actions';
  process.env.STUB_DISABLE_FAIL = '1';
  m.revokeAutoMergeIfEnabled(1, 't');
  assert.strictEqual(process.exitCode, 1);
  assert.ok(said.some((l) => /WARNING/.test(l) && /may still merge unattended/.test(l)), said.join('\n'));
});

console.log('revokeAutoMergeIfEnabled with assumeOurs (the comment-failure caller):');

test("assumeOurs revokes even when enabledBy reads as a person's login", () => {
  // The caller just made this grant itself; an unverified login form must
  // not talk it out of withdrawing it.
  process.env.STUB_BY = 'kivers08';
  m.revokeAutoMergeIfEnabled(1, 't', { assumeOurs: true });
  assert.strictEqual(disabled(), true);
  assert.strictEqual(process.exitCode || 0, 0);
});

test('assumeOurs revokes when enabledBy has no login', () => {
  process.env.STUB_BY = '__nologin__';
  m.revokeAutoMergeIfEnabled(1, 't', { assumeOurs: true });
  assert.strictEqual(disabled(), true);
  assert.strictEqual(process.exitCode || 0, 0);
});

test('assumeOurs still does nothing when the grant is positively not there', () => {
  m.revokeAutoMergeIfEnabled(1, 't', { assumeOurs: true });
  assert.strictEqual(disabled(), false);
  assert.strictEqual(process.exitCode || 0, 0);
});

test('assumeOurs with the state unreadable twice: revoke is ATTEMPTED (we know it is ours)', () => {
  process.env.STUB_VIEW = 'fail';
  m.revokeAutoMergeIfEnabled(1, 't', { assumeOurs: true });
  assert.strictEqual(disabled(), true, 'a grant we made must be withdrawn even if we cannot re-read it');
  assert.strictEqual(process.exitCode || 0, 0);
});

console.log('baseConfig:');

test('no GITHUB_BASE_REF => null (cannot resolve the base ref config)', () => {
  const saved = process.env.GITHUB_BASE_REF;
  delete process.env.GITHUB_BASE_REF;
  try {
    assert.strictEqual(m.baseConfig(), null);
  } finally {
    if (saved !== undefined) process.env.GITHUB_BASE_REF = saved;
  }
});

console.log('baseHasRequiredChecks (the single precondition guarding the T0 marker-free merge):');

// All paths must return false EXCEPT a branch that is both protected and has a
// non-empty required-status-checks context list — anything less than that must
// not let a T0 PR merge unattended.
test('no GITHUB_REPOSITORY => false, and says why', (said) => {
  assert.strictEqual(m.baseHasRequiredChecks('main'), false);
  assert.ok(said.some((l) => /GITHUB_REPOSITORY not set/.test(l)), said.join('\n'));
});

test('gh non-zero => false (branch unreadable / protection endpoint 403)', (said) => {
  process.env.GITHUB_REPOSITORY = 'o/r';
  process.env.STUB_BRANCH = 'fail';
  assert.strictEqual(m.baseHasRequiredChecks('main'), false);
  assert.ok(said.some((l) => /could not read branch "main"/.test(l)), said.join('\n'));
});

test('unparseable payload => false, and says why', (said) => {
  process.env.GITHUB_REPOSITORY = 'o/r';
  process.env.STUB_BRANCH = 'garbage';
  assert.strictEqual(m.baseHasRequiredChecks('main'), false);
  assert.ok(said.some((l) => /could not parse the branch payload/.test(l)), said.join('\n'));
});

test('protected:false with non-empty contexts => false (protection off)', () => {
  process.env.GITHUB_REPOSITORY = 'o/r';
  process.env.STUB_BRANCH = JSON.stringify({
    protected: false,
    protection: { required_status_checks: { contexts: ['reviewer clean'] } },
  });
  assert.strictEqual(m.baseHasRequiredChecks('main'), false);
});

test('protected:true but contexts:[] => false (nothing actually required)', () => {
  process.env.GITHUB_REPOSITORY = 'o/r';
  process.env.STUB_BRANCH = JSON.stringify({
    protected: true,
    protection: { required_status_checks: { contexts: [] } },
  });
  assert.strictEqual(m.baseHasRequiredChecks('main'), false);
});

test('protected:true with required_status_checks absent => false', () => {
  process.env.GITHUB_REPOSITORY = 'o/r';
  process.env.STUB_BRANCH = JSON.stringify({ protected: true, protection: {} });
  assert.strictEqual(m.baseHasRequiredChecks('main'), false);
});

test('protected:true with a non-empty context list => true (the one true case)', () => {
  process.env.GITHUB_REPOSITORY = 'o/r';
  process.env.STUB_BRANCH = JSON.stringify({
    protected: true,
    protection: { required_status_checks: { contexts: ['reviewer clean', 'forge validators'] } },
  });
  assert.strictEqual(m.baseHasRequiredChecks('main'), true);
});

fs.rmSync(STUB_DIR, { recursive: true, force: true });
process.exitCode = 0;
if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nall t0-auto-merge tests passed');
