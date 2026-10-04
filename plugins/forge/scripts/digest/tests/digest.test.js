#!/usr/bin/env node
// Tests for the test/CI digest (package 1). Plain Node asserts, no dependencies (D11).
// Fixtures in tests/fixtures are REAL output captured from Jest 30, ESLint 9 and Prettier 3;
// the CI fixtures wrap that Jest output in GitHub's raw-log format and are served by fake-gh.js.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { digestText } = require('../digest');
const { render } = require('../common');
const { splitSteps, digestJobLog } = require('../ci');

const fx = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');
const CLI = path.join(__dirname, '..', 'digest.js');
const FAKE_GH = path.join(__dirname, 'fake-gh.js');
const cli = (args, env = {}) =>
  spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

let n = 0;
function t(name, fn) {
  fn();
  n++;
  console.log(`ok - ${name}`);
}

t('jest failure: counts, file:line, name, one-line error', () => {
  const r = digestText(fx('jest-fail.txt'), 1);
  assert.strictEqual(r.status, 'FAIL');
  assert.strictEqual(r.failures.length, 3);
  assert.deepStrictEqual(r.failures[0], { where: 'src/b.test.js:1', name: 'throws', error: 'boom happened' });
  assert.strictEqual(r.failures[2].where, 'src/a.test.js:3');
  assert.strictEqual(r.failures[2].error, 'Expected 12.35, received 12.34');
  assert.match(r.failures[1].error, /^suite failed to run: Cannot find module/);
  assert.match(r.summary, /3 passed, 2 failed, 1 skipped/);
});

t('jest pass: counts only, no failures', () => {
  const r = digestText(fx('jest-pass.txt'), 0);
  assert.strictEqual(r.status, 'PASS');
  assert.strictEqual(r.failures.length, 0);
  assert.match(render(r), /^TESTS: PASS \| 1 passed, 0 failed, 0 skipped/);
});

t('exit code wins over parsed counts (never "0 failures" from a mismatch)', () => {
  assert.strictEqual(digestText(fx('jest-pass.txt'), 1).status, 'COULD NOT PARSE');
  assert.strictEqual(digestText(fx('jest-fail.txt'), 0).status, 'COULD NOT PARSE');
});

t('unreadable output: COULD NOT PARSE with the last 20 lines', () => {
  const garbage = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
  const r = digestText(garbage, 1, 'jest');
  assert.strictEqual(r.status, 'COULD NOT PARSE');
  assert.strictEqual(r.tail.length, 20);
  assert.strictEqual(r.tail[19], 'line 50');
  assert.ok(!/0 failed/.test(render(r)));
});

t('cap: 10 failures shown, then "+N more"', () => {
  const blocks = [];
  for (let i = 1; i <= 12; i++) {
    blocks.push(`FAIL src/f${i}.test.js\n  ● case ${i}\n\n    expect(received).toBe(expected)\n\n    Expected: 1\n    Received: 2\n\n      at Object.toBe (src/f${i}.test.js:${i}:1)\n`);
  }
  const text = `${blocks.join('\n')}\nTest Suites: 12 failed, 12 total\nTests:       12 failed, 12 total\nTime:        1 s\n`;
  const out = render(digestText(text, 1));
  assert.match(out, / 10\. src\/f10\.test\.js:10/);
  assert.ok(!/ 11\. /.test(out));
  assert.match(out, /\+2 more/);
});

t('eslint: file, line, rule, message', () => {
  const r = digestText(fx('eslint-fail.txt'), 1);
  assert.strictEqual(r.kind, 'LINT');
  assert.strictEqual(r.failures.length, 3);
  assert.strictEqual(r.failures[2].name, 'no-undef');
  assert.match(r.summary, /3 errors, 0 warnings/);
});

t('prettier: one entry per unformatted file', () => {
  const r = digestText(fx('prettier-fail.txt'), 1);
  assert.strictEqual(r.kind, 'FORMAT');
  assert.deepStrictEqual(r.failures.map((f) => f.where), ['fmt.js', 'lintme.js']);
});

t('generic fallback is labeled low-confidence and never claims counts', () => {
  const r = digestText('compiling...\nAssertionError: nope\nboom\n', 3, 'generic');
  assert.strictEqual(r.status, 'FAIL');
  assert.match(r.summary, /low confidence/);
  assert.strictEqual(digestText('all good\n', 0, 'generic').status, 'PASS');
});

t('digest is short: the real jest failure fits in well under 15 lines', () => {
  const lines = render(digestText(fx('jest-fail.txt'), 1)).trimEnd().split('\n').length;
  assert.ok(lines <= 12, `got ${lines} lines`);
});

t('splitSteps and failed-step pick: lint and format steps are not blamed for the test failure', () => {
  const raw = fs.readFileSync(path.join(__dirname, 'fixtures', 'ci', 'job-fail.log'), 'utf8');
  const steps = splitSteps(raw);
  assert.deepStrictEqual(steps.map((s) => s.command), [
    'actions/checkout@v5', 'npm run lint', 'npm test -- --maxWorkers=2 --bail', 'actions/cache@v4',
  ]);
  const d = digestJobLog(raw);
  assert.strictEqual(d.runner, 'jest');
  assert.strictEqual(d.result.failures.length, 3);
});

t('CLI test: runs a command, digests it, exit code 1 on failure', () => {
  const r = cli(['test', '--', process.execPath, '-e',
    `process.stdout.write(require('fs').readFileSync(${JSON.stringify(path.join(__dirname, 'fixtures', 'jest-fail.txt'))},'utf8'));process.exit(1)`]);
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /^TESTS: FAIL \| 3 passed, 2 failed/);
});

t('CLI test: a passing command exits 0; a command that cannot run exits 2', () => {
  assert.strictEqual(cli(['test', '--', process.execPath, '-e', 'process.exit(0)']).status, 0);
  assert.strictEqual(cli(['test', '--', 'definitely-not-a-command-xyz', 'a']).status, 2);
});

t('CLI ci (fake gh): failed run shows header, job, failed step, failures; lint/format not blamed', () => {
  const r = cli(['ci', 'o/r', '111'], { FORGE_DIGEST_GH: FAKE_GH });
  assert.strictEqual(r.status, 1, r.stderr);
  assert.match(r.stdout, /^CI RUN 111 \| o\/r \| claude\/feature \| abcdef1 \| CI\n/);
  assert.match(r.stdout, /JOB test \| failed step: Run tests \| read as jest/);
  assert.match(r.stdout, /TESTS: FAIL \| 3 passed, 2 failed/);
  assert.match(r.stdout, /NOT RUN: Check formatting\n/);
  assert.ok(!/Post Checkout/.test(r.stdout));
});

t('CLI ci (fake gh): branch name resolves to its latest run; passing run fetches no log', () => {
  assert.match(cli(['ci', 'o/r', 'claude/feature'], { FORGE_DIGEST_GH: FAKE_GH }).stdout, /CI RUN 111/);
  const ok = cli(['ci', 'o/r', '222'], { FORGE_DIGEST_GH: FAKE_GH });
  assert.strictEqual(ok.status, 0);
  assert.match(ok.stdout, /CI: PASS \| no log fetched/);
});

t('CLI ci: missing gh is reported plainly, exit 2', () => {
  const r = cli(['ci', 'o/r', '111'], { FORGE_DIGEST_GH: '/nonexistent/gh' });
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /gh. CLI is not installed/);
});

t('review fix: no exit code and no adapter is COULD NOT PARSE, not a false failure', () => {
  const r = digestText('some output\n', undefined, 'generic');
  assert.strictEqual(r.status, 'COULD NOT PARSE');
  assert.ok(!/undefined/.test(render(r)));
  const viaCli = spawnSync(process.execPath, [CLI, 'parse', '--runner', 'generic'], { encoding: 'utf8', input: 'some output\n' });
  assert.strictEqual(viaCli.status, 2);
});

t('review fix: eslint diagnostics without a rule ID are kept (name null)', () => {
  const text = '\n/app/bad.js\n  3:7  error  Parsing error: Unexpected token }\n\n✖ 1 problem (1 error, 0 warnings)\n';
  const r = digestText(text, 1, 'eslint');
  assert.strictEqual(r.status, 'FAIL');
  assert.strictEqual(r.failures.length, 1);
  assert.strictEqual(r.failures[0].name, null);
  assert.match(r.failures[0].error, /Parsing error/);
  assert.match(render(r), /\/app\/bad\.js:3\n    error: Parsing error/);
});

t('review fix: eslint/prettier contradictions with the exit code are COULD NOT PARSE', () => {
  assert.strictEqual(digestText(fx('eslint-fail.txt'), 0, 'eslint').status, 'COULD NOT PARSE');
  assert.strictEqual(digestText(fx('prettier-fail.txt'), 0, 'prettier').status, 'COULD NOT PARSE');
  // ESLint exits 0 with warnings only; that is a pass, not a contradiction.
  const warnOnly = '\n/app/w.js\n  1:1  warning  Unexpected console  no-console\n\n✖ 1 problem (0 errors, 1 warning)\n';
  assert.strictEqual(digestText(warnOnly, 0, 'eslint').status, 'PASS');
});

t('review fix: a single huge line cannot blow up COULD NOT PARSE output', () => {
  const huge = 'x'.repeat(2000000);
  const out = render(digestText(`${huge}\n`, 1, 'jest'));
  assert.ok(out.length < 5000, `output was ${out.length} chars`);
});

t('review fix: CI picks the adapter from output, not from `npm test` / `npm run lint`', () => {
  const log = [
    '##[group]Run npm test', '> vitest run', ' FAIL  src/a.test.ts > adds', 'AssertionError: nope',
    '##[error]Process completed with exit code 1.',
  ].join('\n');
  const d = digestJobLog(log);
  assert.strictEqual(d.runner, 'generic'); // Vitest output is not Jest; do not force the Jest adapter
  assert.strictEqual(d.result.status, 'FAIL');
  const eslintLog = [
    '##[group]Run npm run lint', '', '/app/x.js', '  1:1  error  Bad  no-undef', '', '✖ 1 problem (1 error, 0 warnings)',
    '##[error]Process completed with exit code 1.',
  ].join('\n');
  assert.strictEqual(digestJobLog(eslintLog).runner, 'eslint');
});

console.log(`${n} passed`);
