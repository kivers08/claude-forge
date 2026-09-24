#!/usr/bin/env node
'use strict';
// Unit tests for lib/segment-split.js, with an emphasis on D27: a guard built
// on `hasUnquotedSequence`/`subcommandAfter` must not be fooled by quoting a
// single word of an otherwise-real command. `gh "pr" merge` runs identically
// to `gh pr merge` in bash, so it must match; `echo "gh pr merge"` (one spaced
// argument) must not. Pure functions, so tested directly rather than through a
// hook payload (cf. tier.test.js).
const assert = require('assert');
const {
  split, tokenize, hasUnquotedSequence, subcommandAfter,
} = require('../lib/segment-split');

let failed = 0;
let ran = 0;

function t(name, fn) {
  ran++;
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}\n  ${e.message}`);
  }
}

const seq = (cmd, words) => hasUnquotedSequence(tokenize(cmd), words);

// --- D27: cosmetic per-word quoting must not evade a sequence match ---------

t('D27: gh "pr" merge matches [gh,pr,merge] (the reported bypass)', () => {
  assert.strictEqual(seq('gh "pr" merge 7 --squash', ['gh', 'pr', 'merge']), true);
});

t("D27: single-quoted word behaves the same as double", () => {
  assert.strictEqual(seq("gh 'pr' merge 7", ['gh', 'pr', 'merge']), true);
});

t('D27: every word quoted still matches (gh "pr" "merge")', () => {
  assert.strictEqual(seq('gh "pr" "merge" 7', ['gh', 'pr', 'merge']), true);
});

t('D27: intra-word quote concatenation matches (me""rge)', () => {
  assert.strictEqual(seq('gh pr me""rge 7', ['gh', 'pr', 'merge']), true);
});

t('D27: quoted --squash flag reads as the flag, not data', () => {
  const words = tokenize('gh pr merge 7 "--squash"').filter((x) => !x.quoted).map((x) => x.value);
  assert.ok(words.includes('--squash'), '--squash should survive as an unquoted-equivalent word');
});

// --- the case the `quoted` flag exists to protect: a spaced blob ------------

t('a spaced quoted blob is one token and does NOT match', () => {
  assert.strictEqual(seq('echo "gh pr merge later"', ['gh', 'pr', 'merge']), false);
});

t('the blob token keeps quoted=true', () => {
  const toks = tokenize('echo "gh pr merge"');
  assert.strictEqual(toks.length, 2, 'echo + one blob');
  assert.strictEqual(toks[1].quoted, true, 'a spaced blob stays opaque');
  assert.strictEqual(toks[1].value, 'gh pr merge');
});

t('a bare word never gains a quoted flag it did not have', () => {
  const toks = tokenize('gh pr merge');
  assert.deepStrictEqual(toks.map((x) => x.quoted), [false, false, false]);
});

// --- subcommandAfter parity (git merge path of the merge gate) --------------

t('D27: subcommandAfter sees a quoted subcommand (git "merge")', () => {
  const sub = subcommandAfter(tokenize('git "merge" main'), 'git', ['-C']);
  assert.ok(sub && sub.sub === 'merge', 'quoted "merge" is still the subcommand');
});

t('subcommandAfter still skips flags and their values', () => {
  const sub = subcommandAfter(tokenize('git -C dir merge main'), 'git', ['-C']);
  assert.ok(sub && sub.sub === 'merge');
});

t('subcommandAfter: a spaced blob is not a bare subcommand', () => {
  const sub = subcommandAfter(tokenize('git "merge main"'), 'git', ['-C']);
  assert.strictEqual(sub, null, 'the blob "merge main" is not the word "merge"');
});

// --- split() sanity (unchanged behavior, guarded against regressions) -------

t('split keeps a quoted separator inside one segment', () => {
  assert.deepStrictEqual(split('echo "a && b"'), ['echo "a && b"']);
});

t('split breaks on a real && separator', () => {
  assert.deepStrictEqual(split('echo hi && gh pr merge'), ['echo hi', 'gh pr merge']);
});

t('quoted PR number/URL reads as the identifier, not data', () => {
  const toks = tokenize('gh pr merge "https://example.test/x/pull/7"');
  const url = toks[toks.length - 1];
  assert.strictEqual(url.quoted, false, 'an identifier-punctuation token is bare');
  assert.strictEqual(url.value, 'https://example.test/x/pull/7');
});

console.log(`\n${ran - failed}/${ran} passed`);
process.exit(failed ? 1 : 0);
