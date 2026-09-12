'use strict';
// D21: shared changelog.d/*.md fragment-shape parser, used by both
// validate-changelog.js and changelog-closeout.js so "malformed" means the
// same thing in both places (they used to carry independent, divergent
// implementations — see changelog.d/README.md for the documented shape).
//
// No npm dependencies.

const fs = require('fs');
const path = require('path');

function rel(root, p) {
  return path.relative(root, p).split(path.sep).join('/');
}

// Returns { sections: [{ name, bullets: [string] }], errors: [string] } for
// one fragment file. `sections` preserves first-encountered order within
// the fragment. On any shape error, `errors` is non-empty and `sections`
// may be incomplete — callers must check errors before using sections.
//
// Shape: a `section: <name>` line starts a new section (blank lines
// between/around sections are optional and otherwise ignored); each
// subsequent `- bullet` line belongs to the current section; an indented,
// non-bulleted line continues the previous bullet's text.
function parseFragment(file, root) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const errors = [];
  const sections = [];
  let current = null; // { name, bullets }
  const label = rel(root, file);

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
        errors.push(`${label}:${lineNo}: empty section name`);
        continue;
      }
      current = { name, bullets: [] };
      sections.push(current);
    } else if (bulletMatch) {
      if (!current) {
        errors.push(`${label}:${lineNo}: bullet before any "section:" line`);
        continue;
      }
      current.bullets.push(bulletMatch[1].trim());
    } else if (continuationMatch) {
      if (!current || current.bullets.length === 0) {
        errors.push(`${label}:${lineNo}: continuation line with no preceding bullet`);
        continue;
      }
      current.bullets[current.bullets.length - 1] += ' ' + line.trim();
    } else {
      errors.push(`${label}:${lineNo}: unrecognized line (expected "section:", "- bullet", or an indented continuation): ${JSON.stringify(line)}`);
    }
  }

  if (sections.length === 0 && errors.length === 0) {
    errors.push(`${label}: no "section:" block found`);
  }
  for (const s of sections) {
    if (s.bullets.length === 0) {
      errors.push(`${label}: section "${s.name}" has no bullets`);
    }
  }

  return { sections, errors };
}

function listFragmentFiles(fragmentsDir) {
  if (!fs.existsSync(fragmentsDir)) return [];
  return fs
    .readdirSync(fragmentsDir)
    .filter((f) => f !== 'README.md' && f.endsWith('.md'))
    .sort()
    .map((f) => path.join(fragmentsDir, f));
}

module.exports = { parseFragment, listFragmentFiles };
