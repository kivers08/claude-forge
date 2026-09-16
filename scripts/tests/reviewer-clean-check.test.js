#!/usr/bin/env node
// Tests for the pure, deterministic parts of scripts/reviewer-clean-check.js:
// the diff-resolved acknowledgement gate (what decides whether a review
// counts at all) and the summary parser (what decides pass/fail from it).
// Plain Node asserts, no dependencies — same convention as the rest of the
// repo's scripts (D11).
'use strict';

const assert = require('assert');
const {
  parseSummary,
  verifyDiffResolvedAck,
  matchesInstructionSurface,
  capText,
} = require('../reviewer-clean-check.js');

const BASE = '3e5422e9955e3af53f55d889e4f3932f454bde16';
const HEAD = '9d809ab13f2b59aabe208bb8a6fd82886d4300de';
const TOKEN = 'b6b4041958bf2b33';
const ack = (t) => verifyDiffResolvedAck(t, BASE, HEAD, TOKEN);

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

console.log('verifyDiffResolvedAck:');

test('accepts full SHAs with the exact token', () => {
  assert.strictEqual(ack(`diff-resolved: ${BASE}..${HEAD} token=${TOKEN}`).ok, true);
});

test('accepts abbreviated SHAs that are genuine prefixes', () => {
  assert.strictEqual(ack(`diff-resolved: 3e5422e..9d809ab token=${TOKEN}`).ok, true);
});

test('accepts an uppercased token', () => {
  assert.strictEqual(ack(`diff-resolved: 3e5422e..9d809ab token=${TOKEN.toUpperCase()}`).ok, true);
});

test('rejects a one-character "SHA" (the reversed-prefix forgery)', () => {
  // `3..9` is a prefix of neither SHA in the accepted direction; the {7,40}
  // bound rejects it before the prefix check even runs.
  assert.strictEqual(ack(`diff-resolved: 3..9 token=${TOKEN}`).ok, false);
});

test('rejects a 6-hex "prefix" as too short to be a real abbreviation', () => {
  assert.strictEqual(ack(`diff-resolved: 3e5422..9d809a token=${TOKEN}`).ok, false);
});

test('rejects a found SHA longer than the expected one', () => {
  assert.strictEqual(ack(`diff-resolved: ${BASE}0..${HEAD} token=${TOKEN}`).ok, false);
});

test('rejects correct SHAs with a wrong token (never read the diff file)', () => {
  const r = ack(`diff-resolved: ${BASE}..${HEAD} token=0000000000000000`);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /verification token does not match/);
});

test('rejects a stale head SHA', () => {
  const stale = '0e1720e11111111111111111111111111111111';
  const r = ack(`diff-resolved: ${BASE}..${stale} token=${TOKEN}`);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /head SHA mismatch/);
});

test('rejects output with no acknowledgement line at all', () => {
  const r = ack('I reviewed everything. 0 bugs, 0 security issues, 0 convention violations, 0 suggestions.');
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /missing the required/);
});

test('an earlier quoted example does not shadow the real ack line', () => {
  const text = [
    'The format is `diff-resolved: aaaaaaa..bbbbbbb token=ffffffffffffffff`.',
    `diff-resolved: ${BASE}..${HEAD} token=${TOKEN}`,
  ].join('\n');
  assert.strictEqual(ack(text).ok, true);
});

console.log('parseSummary:');

test('parses a well-formed summary line', () => {
  const s = parseSummary('2 bugs, 1 security issue, 0 convention violations, 6 suggestions.');
  assert.deepStrictEqual(s, { bugs: 2, security: 1, convention: 0, suggestions: 6 });
});

test('keeps the LAST match when the body restates the shape', () => {
  const text = [
    'An example line: 9 bugs, 9 security issues, 9 convention violations, 9 suggestions.',
    'Final: 0 bugs, 0 security issues, 0 convention violations, 3 suggestions.',
  ].join('\n');
  assert.deepStrictEqual(parseSummary(text), { bugs: 0, security: 0, convention: 0, suggestions: 3 });
});

test('tolerates a parenthetical annotation on a count (the real CI failure)', () => {
  // Verbatim from a real reviewer run; the strict form failed the whole
  // required check with "could not find the reviewer's required summary line".
  const s = parseSummary('2 bugs, 4 security issues (1 pre-existing and already tracked), 1 convention violation, 2 suggestions.');
  assert.deepStrictEqual(s, { bugs: 2, security: 4, convention: 1, suggestions: 2 });
});

test('tolerates an annotation containing a comma, and a trailing "and"', () => {
  assert.deepStrictEqual(
    parseSummary('1 bug, 2 security issues (1 pre-existing, tracked), 0 convention violations, 3 suggestions.'),
    { bugs: 1, security: 2, convention: 0, suggestions: 3 },
  );
  assert.deepStrictEqual(
    parseSummary('1 bug, 0 security issues, 0 convention violations, and 2 suggestions.'),
    { bugs: 1, security: 0, convention: 0, suggestions: 2 },
  );
});

test('returns null when no summary line is present', () => {
  assert.strictEqual(parseSummary('Looks fine to me.'), null);
});

console.log('matchesInstructionSurface:');

// Every pattern is anchored, so these are byte-exact assertions about what
// the gate fires on. The `-z` / core.quotePath=false invocation in
// changedInstructionSurfaces exists to guarantee the paths reaching this
// function are raw — a git-quoted `".claude/rules/caf\303\251.md"` would
// defeat the ^ anchor and fail open.
const SURFACES = [
  ['CLAUDE.md', true, 'root CLAUDE.md'],
  ['CLAUDE.local.md', true, 'root CLAUDE.local.md'],
  ['docs/CLAUDE.md', true, 'nested CLAUDE.md'],
  ['AGENTS.md', true, 'root AGENTS.md'],
  ['NOTCLAUDE.md', false, 'a file merely ending in CLAUDE.md'],
  ['CLAUDE.md.framework-block', false, 'the framework-block template'],
  ['.claude/settings.json', true, 'project settings'],
  ['.claude/settings.local.json', true, 'local project settings'],
  ['.claude/forge.json', true, 'forge config (extraChecks/budget)'],
  ['plugins/forge/hooks/tests/fixtures/tiers/.claude/forge.json', false, 'a forge.json test fixture'],
  ['.claude/rules/smoke-rule.md', true, 'a rules file'],
  ['.claude/rules/nested/x.md', true, 'a nested rules file'],
  ['.claude/agent-memory/forge-reviewer/x.md', false, 'agent memory (known gap, see D20)'],
  ['plugins/forge/agents/reviewer.md', false, 'the reviewer agent (read from base ref)'],
  ['scripts/reviewer-clean-check.js', false, 'ordinary source'],
  ['.claude/rules/café.md', true, 'a non-ASCII rules filename, raw'],
  ['.claude/skills/helper/SKILL.md', true, 'a project skill'],
  ['.claude/agents/x.md', true, 'a project subagent'],
  ['.claude/commands/x.md', true, 'a project slash command'],
  ['plugins/forge/skills/pipeline/SKILL.md', false, 'a plugin skill (loads from the marketplace clone)'],
  ['.claude/hooks/session-start.sh', true, 'a project hook (executable)'],
  ['.claude/hooks/tests/session-start.test.sh', true, 'a project hook test'],
];

// The gate compares raw bytes. git quotes non-ASCII paths by default, which
// would defeat every anchor — changedInstructionSurfaces passes -z and
// core.quotePath=false so this never reaches the matcher, and this row pins
// what would happen if that regressed.
test('a git-QUOTED non-ASCII path would fail open (why -z is load-bearing)', () => {
  assert.strictEqual(
    matchesInstructionSurface('".claude/rules/caf\\303\\251.md"', null),
    false,
    'quoted form must not match — the -z flag is what prevents this input',
  );
});

for (const [p, expected, label] of SURFACES) {
  test(`${expected ? 'gates' : 'allows'} ${label}`, () => {
    assert.strictEqual(matchesInstructionSurface(p, null), expected, p);
  });
}

test('gates the configured lessons path, and only that path', () => {
  assert.strictEqual(matchesInstructionSurface('tasks/lessons.md', 'tasks/lessons.md'), true);
  assert.strictEqual(matchesInstructionSurface('tasks/lessons.md', null), false);
  assert.strictEqual(matchesInstructionSurface('tasks/other.md', 'tasks/lessons.md'), false);
});

test('an empty lessons path does not gate every file', () => {
  assert.strictEqual(matchesInstructionSurface('README.md', ''), false);
});

console.log('git probe behaviour (pins what lessonsPathFromBase relies on):');

// lessonsPathFromBase must tell "the base ref has no .claude/forge.json"
// apart from "git failed", or it silently stops gating the lessons file.
// The first cut used `git cat-file -e`, which exits 128 for a missing path —
// indistinguishable from a fault — and failed every CI run on this repo,
// which has no .claude/forge.json. These assertions pin the git behaviour
// the current `ls-tree` probe depends on, ref-independently (HEAD always
// exists, so this works in any checkout depth).
const { spawnSync } = require('child_process');
const lsTree = (p) => spawnSync('git', ['ls-tree', '--name-only', 'HEAD', '--', p], {
  cwd: require('path').resolve(__dirname, '../..'),
  encoding: 'utf8',
});

test('ls-tree reports an absent path as exit 0 with empty stdout', () => {
  const r = lsTree('no/such/path/forge.json');
  assert.strictEqual(r.status, 0, 'absent path must not look like a fault');
  assert.strictEqual(r.stdout.trim(), '', 'absent path must list nothing');
  assert.strictEqual((r.stderr || '').trim(), '', 'absent path must not warn');
});

test('ls-tree reports a present path on stdout', () => {
  const r = lsTree('scripts/reviewer-clean-check.js');
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), 'scripts/reviewer-clean-check.js');
});

test('cat-file -e cannot distinguish absent from fault (why ls-tree is used)', () => {
  const r = spawnSync('git', ['cat-file', '-e', 'HEAD:no/such/path/forge.json'], {
    cwd: require('path').resolve(__dirname, '../..'),
    encoding: 'utf8',
  });
  assert.notStrictEqual(r.status, 1, 'if this ever became 1, cat-file would be usable');
});

console.log('ack formatting tolerance:');

test('accepts a markdown-emphasised ack line', () => {
  assert.strictEqual(ack(`**diff-resolved:** ${BASE}..${HEAD} token=\`${TOKEN}\``).ok, true);
});

test('accepts a three-dot range', () => {
  assert.strictEqual(ack(`diff-resolved: ${BASE}...${HEAD} token=${TOKEN}`).ok, true);
});

console.log('capText (truncation gate — body blocks, file list only annotates in main()):');

test('returns the text unchanged and truncated:false at or under the cap', () => {
  const r = capText('abcde', 5, 'body');
  assert.strictEqual(r.truncated, false);
  assert.strictEqual(r.text, 'abcde');
});

test('truncated:true and an inline note once over the cap', () => {
  const r = capText('abcdef', 5, 'body');
  assert.strictEqual(r.truncated, true);
  assert.ok(r.text.startsWith('abcde'), 'keeps the first `max` chars');
  assert.ok(/\[TRUNCATED body — 5 of 6 chars shown\]/.test(r.text), 'names kind and both sizes');
});

test('one char over the cap already truncates (boundary)', () => {
  assert.strictEqual(capText('x'.repeat(6), 5, 'file list').truncated, true);
  assert.strictEqual(capText('x'.repeat(5), 5, 'file list').truncated, false);
});

test('the kind label distinguishes body from file list', () => {
  assert.ok(capText('abcdef', 5, 'file list').text.includes('TRUNCATED file list —'));
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nall reviewer-clean-check tests passed');
