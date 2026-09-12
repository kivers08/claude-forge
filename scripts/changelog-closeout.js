#!/usr/bin/env node
'use strict';
// D21 changelog close-out: assembles changelog.d/ fragments into a dated
// header at the top of CHANGELOG.md, then deletes the fragments.
//
// On-demand only (run by a human or an agent explicitly invoking it) — not
// wired into CI or a git hook. Full automation is D22, still deferred.
//
// Fragment shape (see changelog.d/README.md): parsing itself lives in
// scripts/lib/changelog-fragment.js, shared with validate-changelog.js so
// "malformed" means the same thing in both places.
//
// Refuses to run (exit 1, no changes made) if there are zero fragments to
// assemble, or if any fragment is malformed.
//
// No npm dependencies.

const fs = require('fs');
const path = require('path');
const { parseFragment, listFragmentFiles } = require('./lib/changelog-fragment');
const { load, get } = require('../plugins/forge/hooks/lib/config');

const ROOT = path.resolve(__dirname, '..');
// D12/D21: both paths are project-configurable (changelog.fragmentsDir,
// changelog.file in .claude/forge.json), defaulting to 'changelog.d' and
// 'CHANGELOG.md' — this repo itself has no forge.json, so it always falls
// through to those defaults, but a project that adopts forge and sets
// either key must have it honored here, not silently ignored.
const { config } = load(ROOT);
const FRAGMENTS_DIR = path.join(ROOT, get(config, 'changelog.fragmentsDir', 'changelog.d'));
const CHANGELOG_FILE = path.join(ROOT, get(config, 'changelog.file', 'CHANGELOG.md'));

function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join('/');
}

// ---- assembly ----------------------------------------------------------------
function todayDate() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function buildDatedSection(groups, date) {
  const parts = [`## ${date}`, ''];
  for (const g of groups) {
    parts.push(`### ${g.name}`, '');
    for (const bullet of g.bullets) parts.push(`- ${bullet}`);
    parts.push('');
  }
  return parts.join('\n').replace(/\n+$/, '\n');
}

function prependToChangelog(datedSection) {
  const text = fs.existsSync(CHANGELOG_FILE) ? fs.readFileSync(CHANGELOG_FILE, 'utf8') : '# Changelog\n';
  const titleMatch = /^(# .+\n)(\n*)/.exec(text);
  if (!titleMatch) {
    // No H1 title found; just prepend the dated section to the top.
    return `${datedSection}\n${text}`;
  }
  const title = titleMatch[1];
  const rest = text.slice(titleMatch[0].length);
  return `${title}\n${datedSection}\n${rest}`;
}

function main() {
  const files = listFragmentFiles(FRAGMENTS_DIR);
  if (files.length === 0) {
    console.log('nothing to assemble: changelog.d/ has no fragments (only README.md, if present)');
    process.exit(1);
  }

  const parsed = files.map((f) => ({ file: f, ...parseFragment(f, ROOT) }));
  const allErrors = parsed.flatMap((p) => p.errors);
  if (allErrors.length > 0) {
    console.error('refusing to assemble: one or more fragments are malformed.');
    console.error('run `node scripts/validate-changelog.js` for full details. Errors found here:');
    for (const e of allErrors) console.error(`  error: ${e}`);
    process.exit(1);
  }

  // Group by section name, in order first encountered across fragments
  // (fragments processed in sorted filename order for determinism).
  const groupOrder = [];
  const groupsByName = new Map();
  for (const p of parsed) {
    for (const s of p.sections) {
      if (!groupsByName.has(s.name)) {
        groupsByName.set(s.name, { name: s.name, bullets: [] });
        groupOrder.push(s.name);
      }
      groupsByName.get(s.name).bullets.push(...s.bullets);
    }
  }
  const groups = groupOrder.map((n) => groupsByName.get(n));

  const datedSection = buildDatedSection(groups, todayDate());
  const newChangelog = prependToChangelog(datedSection);
  fs.writeFileSync(CHANGELOG_FILE, newChangelog);

  for (const f of files) fs.unlinkSync(f);

  console.log(`assembled ${files.length} fragment(s) into ${rel(CHANGELOG_FILE)} and deleted them:`);
  for (const f of files) console.log(`  - ${rel(f)}`);
}

main();
