#!/usr/bin/env node
'use strict';
// D21: validate changelog.d/ fragment shape. Every file in changelog.d/
// except README.md must be one or more blocks of:
//   section: <name>
//   - bullet (may continue on following indented, non-bulleted lines)
// separated by blank lines. Shape only — this does not enforce a fixed
// whitelist of section names, since existing fragments already use names
// (e.g. "Decided") beyond the README's illustrative list.
// No npm dependencies. Exit 1 listing every malformed fragment.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'changelog.d');

function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join('/');
}

function checkFragment(file) {
  const errors = [];
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) {
    errors.push('file is empty');
    return errors;
  }

  // Split into blank-line-separated blocks.
  const blocks = [];
  let current = [];
  for (const line of lines) {
    if (line.trim() === '') {
      if (current.length) blocks.push(current);
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length) blocks.push(current);

  if (blocks.length === 0) {
    errors.push('no section blocks found');
    return errors;
  }

  for (const block of blocks) {
    const [first, ...rest] = block;
    const m = /^section:\s*(\S.*)$/.exec(first);
    if (!m) {
      errors.push(`block does not start with "section: <name>": ${JSON.stringify(first)}`);
      continue;
    }
    const bullets = rest.filter((l) => /^-\s+/.test(l));
    if (bullets.length === 0) {
      errors.push(`section "${m[1]}" has no "- " bullets`);
      continue;
    }
    // Every line before the first bullet is a stray top-level line, not a
    // valid continuation (continuations only follow a bullet). A valid
    // continuation must also actually be indented — an unindented,
    // non-bulleted line after a bullet is a malformed second bullet
    // missing its "- " prefix, not a continuation.
    let seenBullet = false;
    for (const line of rest) {
      if (/^-\s+/.test(line)) { seenBullet = true; continue; }
      if (!seenBullet) {
        errors.push(`section "${m[1]}": line appears before any "- " bullet: ${JSON.stringify(line)}`);
      } else if (!/^\s+\S/.test(line)) {
        errors.push(`section "${m[1]}": unindented line after a bullet, not a valid continuation: ${JSON.stringify(line)}`);
      }
    }
  }
  return errors;
}

if (!fs.existsSync(DIR)) {
  console.error(`error: ${rel(DIR)} does not exist`);
  process.exit(1);
}

const names = fs.readdirSync(DIR).filter((n) => n !== 'README.md' && !fs.statSync(path.join(DIR, n)).isDirectory());
const failures = [];
for (const name of names) {
  const file = path.join(DIR, name);
  const errors = checkFragment(file);
  if (errors.length) failures.push({ file: rel(file), errors });
}

if (failures.length) {
  for (const f of failures) {
    console.error(`error: ${f.file}:`);
    for (const e of f.errors) console.error(`  - ${e}`);
  }
  console.error(`\n${failures.length} malformed fragment(s)`);
  process.exit(1);
}
console.log(`ok: ${names.length} fragment(s) valid`);
