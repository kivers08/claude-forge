#!/usr/bin/env node
'use strict';
// D21: validate changelog.d/ fragment shape. Parsing lives in
// scripts/lib/changelog-fragment.js, shared with changelog-closeout.js so
// "malformed" means the same thing in both places — see that module for
// the shape definition and changelog.d/README.md for the documented format.
// No npm dependencies. Exit 1 listing every malformed fragment.

const fs = require('fs');
const path = require('path');
const { parseFragment, listFragmentFiles } = require('./lib/changelog-fragment');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'changelog.d');

function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join('/');
}

if (!fs.existsSync(DIR)) {
  console.error(`error: ${rel(DIR)} does not exist`);
  process.exit(1);
}

const files = listFragmentFiles(DIR);
const allErrors = [];
for (const file of files) {
  const { errors } = parseFragment(file, ROOT);
  allErrors.push(...errors);
}

if (allErrors.length) {
  for (const e of allErrors) console.error(`error: ${e}`);
  console.error(`\n${allErrors.length} error(s) across changelog.d/ fragments`);
  process.exit(1);
}
console.log(`ok: ${files.length} fragment(s) valid`);
