#!/usr/bin/env node
'use strict';
// D21: validate changelog.d/ fragment shape. Parsing lives in
// scripts/lib/changelog-fragment.js, shared with changelog-closeout.js so
// "malformed" means the same thing in both places — see that module for
// the shape definition and changelog.d/README.md for the documented format.
// No npm dependencies. Exit 1 listing every malformed fragment.

const fs = require('fs');
const path = require('path');
const { parseFragment, listFragmentFiles, resolveInside } = require('./lib/changelog-fragment');
const { load, get } = require('../plugins/forge/hooks/lib/config');

// FORGE_REPO_ROOT lets tests point this at a fixture repo; normally the repo
// root, one level up from scripts/.
const ROOT = process.env.FORGE_REPO_ROOT
  ? path.resolve(process.env.FORGE_REPO_ROOT)
  : path.resolve(__dirname, '..');
// D12/D21: changelog.d/ location is project-configurable
// (changelog.fragmentsDir in .claude/forge.json), defaulting to
// 'changelog.d' — this repo itself has no forge.json, so it always falls
// through to that default, but a project that adopts forge and sets this
// key must have it honored here, not silently ignored.
// Fail closed on a malformed config, don't fall through to defaults. load()
// returns a non-null `error` only when .claude/forge.json exists but is
// unreadable/unparseable (a missing file is error:null — the normal case).
// Silently ignoring it would validate the DEFAULT changelog.d and print a
// green `forge validators` status computed against a config it never read.
// Fail-closed on a malformed config, like the other CI scripts.
const { config, file, error } = load(ROOT);
if (error) {
  console.error(`error: ${file} could not be read: ${error}`);
  process.exit(1);
}
// Contained, not joined: see resolveInside for why a PR-controlled
// .claude/forge.json must not be able to point this outside the checkout.
let DIR;
try {
  DIR = resolveInside(ROOT, get(config, 'changelog.fragmentsDir', 'changelog.d'), 'changelog.fragmentsDir');
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(1);
}

function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join('/');
}

if (!fs.existsSync(DIR)) {
  console.error(`error: ${rel(DIR)} does not exist`);
  process.exit(1);
}

// A symlinked or otherwise irregular fragment throws from the lister or the
// parser; that is a validation failure, reported like any other.
let files;
const allErrors = [];
try {
  files = listFragmentFiles(DIR, ROOT);
  for (const file of files) {
    const { errors } = parseFragment(file, ROOT);
    allErrors.push(...errors);
  }
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(1);
}

if (allErrors.length) {
  for (const e of allErrors) console.error(`error: ${e}`);
  console.error(`\n${allErrors.length} error(s) across ${rel(DIR)}/ fragments`);
  process.exit(1);
}
console.log(`ok: ${files.length} fragment(s) valid`);
