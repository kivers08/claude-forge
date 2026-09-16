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
  // Defense in depth for direct callers: listFragmentFiles already refuses
  // symlinks, but this is exported and readFileSync follows links.
  if (fs.lstatSync(file).isSymbolicLink()) {
    throw new Error(`${rel(root, file)} is a symlink; fragments must be regular files`);
  }
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

// Refuses a path that is itself a symlink. Git stores and checks out symlinks
// verbatim, so a PR can commit `changelog.d -> /somewhere/else`; every
// per-entry check below would then run against the link's target.
function assertNotSymlink(p, root, what) {
  let st;
  try { st = fs.lstatSync(p); } catch (e) { return; } // absent: caller reports
  if (st.isSymbolicLink()) {
    throw new Error(`${rel(root, p)} is a symlink; ${what} must be a real path inside the repository`);
  }
}

// Lists fragment files. Every *.md entry must be a REGULAR file, decided by
// lstat rather than Dirent type flags: on filesystems that report DT_UNKNOWN
// (XFS with ftype=0, some network/overlay mounts) isFile()/isSymbolicLink()/
// isDirectory() are all false and a type-flag check would reject every valid
// fragment. lstat does not follow links, so a symlink is a hard error rather
// than a silent read — a PR committing changelog.d/leak.md as a symlink to a
// credentials file in the runner's home would otherwise have its target read,
// echoed by the validator, and copied into CHANGELOG.md on close-out. Failing
// CI loudly is the only honest outcome. Non-.md entries (the close-out staging
// dir, editor droppings) are ignored. `root` is for repo-relative messages.
function listFragmentFiles(fragmentsDir, root) {
  const r = root || path.dirname(fragmentsDir);
  if (!fs.existsSync(fragmentsDir)) return [];
  assertNotSymlink(fragmentsDir, r, 'the fragments directory');
  const names = [];
  for (const name of fs.readdirSync(fragmentsDir)) {
    if (name === 'README.md' || !name.endsWith('.md')) continue;
    const full = path.join(fragmentsDir, name);
    const st = fs.lstatSync(full);
    if (!st.isFile()) {
      const kind = st.isSymbolicLink() ? 'a symlink' : st.isDirectory() ? 'a directory' : 'not a regular file';
      throw new Error(`${rel(r, full)} is ${kind}; fragments must be regular files`);
    }
    names.push(name);
  }
  return names.sort().map((f) => path.join(fragmentsDir, f));
}

// Real path of the deepest ancestor of `p` that exists, so a not-yet-created
// leaf (a fresh CHANGELOG.md) can still be checked against its parent.
function realpathOfDeepestExisting(p) {
  let cur = p;
  for (;;) {
    if (fs.existsSync(cur)) return fs.realpathSync(cur);
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

// Resolves a project-configurable, repo-relative path (changelog.fragmentsDir,
// changelog.file) and REFUSES anything that escapes the repo. Two checks,
// both required:
//   1. lexical — path.resolve then a prefix test against ROOT, so "../../etc"
//      and absolute values are rejected before touching the filesystem;
//   2. physical — the real path of the deepest existing ancestor must also be
//      under the real root. Git checks out committed symlinks verbatim, so a
//      PR can add `docs/out -> /home/runner/.claude` and set
//      fragmentsDir: "docs/out": lexically inside, physically not. Without
//      this, validate-changelog echoes files from outside the checkout and
//      changelog-closeout renames and deletes them.
function resolveInside(root, value, keyName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${keyName} must be a non-empty string`);
  }
  const abs = path.resolve(root, value);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`${keyName} must stay inside the repository: ${value}`);
  }
  const rootReal = fs.realpathSync(root);
  const real = realpathOfDeepestExisting(abs);
  if (real !== null && real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    throw new Error(`${keyName} resolves (through a symlink) to outside the repository: ${value}`);
  }
  return abs;
}

module.exports = { parseFragment, listFragmentFiles, resolveInside, assertNotSymlink };
