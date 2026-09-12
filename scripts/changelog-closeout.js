#!/usr/bin/env node
'use strict';
// D21 changelog close-out: assembles changelog.d/ fragments into a dated
// header at the top of CHANGELOG.md, then deletes the fragments.
//
// On-demand only (run by a human or an agent explicitly invoking it) — not
// wired into CI or a git hook. Full automation is D22, still deferred.
//
// Fragment shape (see changelog.d/README.md):
//   section: Added | Changed | Fixed | Removed | Docs
//   - one bullet per change, present tense, no PR number needed
// A fragment may contain more than one `section:` block, blank-line
// separated. Bullet continuation lines are indented.
//
// Refuses to run (exit 1, no changes made) if there are zero fragments to
// assemble, or if any fragment is malformed.
//
// No npm dependencies.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FRAGMENTS_DIR = path.join(ROOT, 'changelog.d');
const CHANGELOG_FILE = path.join(ROOT, 'CHANGELOG.md');

function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join('/');
}

// ---- fragment parsing -------------------------------------------------------
// Returns { sections: [{ name, bullets: [string] }], errors: [string] } for
// one fragment file. `sections` preserves first-encountered order within the
// fragment. On any shape error, `errors` is non-empty and `sections` may be
// incomplete — callers must check errors before using sections.
function parseFragment(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const errors = [];
  const sections = [];
  let current = null; // { name, bullets }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    if (!line.trim()) continue;

    const sectionMatch = /^section:\s*(.+)$/.exec(line);
    const bulletMatch = /^-\s+(.+)$/.exec(line);
    const continuationMatch = /^\s+\S/.test(line);

    if (sectionMatch) {
      const name = sectionMatch[1].trim();
      if (!name) {
        errors.push(`${rel(file)}:${lineNo}: empty section name`);
        continue;
      }
      current = { name, bullets: [] };
      sections.push(current);
    } else if (bulletMatch) {
      if (!current) {
        errors.push(`${rel(file)}:${lineNo}: bullet before any "section:" line`);
        continue;
      }
      current.bullets.push(bulletMatch[1].trim());
    } else if (continuationMatch) {
      if (!current || current.bullets.length === 0) {
        errors.push(`${rel(file)}:${lineNo}: continuation line with no preceding bullet`);
        continue;
      }
      current.bullets[current.bullets.length - 1] += ' ' + line.trim();
    } else {
      errors.push(`${rel(file)}:${lineNo}: unrecognized line (expected "section:", "- bullet", or an indented continuation): ${JSON.stringify(line)}`);
    }
  }

  if (sections.length === 0 && errors.length === 0) {
    errors.push(`${rel(file)}: no "section:" block found`);
  }
  for (const s of sections) {
    if (s.bullets.length === 0) {
      errors.push(`${rel(file)}: section "${s.name}" has no bullets`);
    }
  }

  return { sections, errors };
}

// ---- assembly ----------------------------------------------------------------
function listFragmentFiles() {
  if (!fs.existsSync(FRAGMENTS_DIR)) return [];
  return fs
    .readdirSync(FRAGMENTS_DIR)
    .filter((f) => f !== 'README.md' && f.endsWith('.md'))
    .sort()
    .map((f) => path.join(FRAGMENTS_DIR, f));
}

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
  const files = listFragmentFiles();
  if (files.length === 0) {
    console.log('nothing to assemble: changelog.d/ has no fragments (only README.md, if present)');
    process.exit(1);
  }

  const parsed = files.map((f) => ({ file: f, ...parseFragment(f) }));
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
