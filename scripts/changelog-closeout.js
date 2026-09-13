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
const { parseFragment, listFragmentFiles, resolveInside, assertNotSymlink } = require('./lib/changelog-fragment');
const { load, get } = require('../plugins/forge/hooks/lib/config');

// FORGE_REPO_ROOT lets tests point this at a fixture repo; normally the repo
// root, one level up from scripts/.
const ROOT = process.env.FORGE_REPO_ROOT
  ? path.resolve(process.env.FORGE_REPO_ROOT)
  : path.resolve(__dirname, '..');
// D12/D21: both paths are project-configurable (changelog.fragmentsDir,
// changelog.file in .claude/forge.json), defaulting to 'changelog.d' and
// 'CHANGELOG.md' — this repo itself has no forge.json, so it always falls
// through to those defaults, but a project that adopts forge and sets
// either key must have it honored here, not silently ignored.
const { config } = load(ROOT);
// Contained, not joined: this script DELETES every *.md it enumerates and
// overwrites the changelog path, so "../../" in either key must be refused,
// not honoured. See resolveInside.
let FRAGMENTS_DIR;
let CHANGELOG_FILE;
try {
  FRAGMENTS_DIR = resolveInside(ROOT, get(config, 'changelog.fragmentsDir', 'changelog.d'), 'changelog.fragmentsDir');
  CHANGELOG_FILE = resolveInside(ROOT, get(config, 'changelog.file', 'CHANGELOG.md'), 'changelog.file');
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(1);
}
// Fragments are moved here before the changelog is written, so an
// interrupted run leaves evidence instead of a duplicate-on-rerun trap.
const STAGING_DIR = path.join(FRAGMENTS_DIR, '.closeout-staging');

// The shared lib throws on a symlinked/irregular fragment or a symlinked
// target; report that like every other refusal (an `error:` line, exit 1),
// not as an uncaught stack trace. Nothing has been touched at any call site.
function orExit(fn) {
  try {
    return fn();
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
}

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
  const files = orExit(() => listFragmentFiles(FRAGMENTS_DIR, ROOT));
  // Inspected FIRST, before the zero-fragments exit below. The interruption
  // this exists for — death between the rename loop and the final rmSync —
  // leaves ZERO live fragments and all of them in staging, so a check placed
  // after "nothing to assemble" would never run in the one case it is for.
  let stagingStat = null;
  try { stagingStat = fs.lstatSync(STAGING_DIR); } catch (e) { /* absent: normal */ }
  if (stagingStat && !stagingStat.isDirectory()) {
    console.error(`error: ${rel(STAGING_DIR)} exists but is not a directory — remove it and re-run.`);
    process.exit(1);
  }
  if (stagingStat && orExit(() => fs.readdirSync(STAGING_DIR)).length > 0) {
    if (fs.existsSync(path.join(STAGING_DIR, 'PUBLISHED'))) {
      // The previous run got the changelog written but could not remove
      // staging; it left this marker so the answer here is known, not asked.
      console.error(`error: ${rel(STAGING_DIR)}/ is left over from a run whose changelog write DID succeed — its fragments are already in ${rel(CHANGELOG_FILE)}. Delete the directory and re-run.`);
    } else {
      console.error(`error: ${rel(STAGING_DIR)}/ is not empty — a previous close-out was interrupted after moving fragments there.`);
      console.error(`Check whether their bullets already appear in ${rel(CHANGELOG_FILE)}; if so delete the directory, if not move the files back, then re-run.`);
    }
    process.exit(1);
  }
  if (files.length === 0) {
    console.error(`nothing to assemble: ${rel(FRAGMENTS_DIR)}/ has no fragments (only README.md, if present)`);
    process.exit(1);
  }

  const parsed = orExit(() => files.map((f) => ({ file: f, ...parseFragment(f, ROOT) })));
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
  orExit(() => assertNotSymlink(CHANGELOG_FILE, ROOT, 'changelog.file'));
  // And an existing target that is not a regular file (a directory left by a
  // bad merge, a FIFO): prependToChangelog reads it, so say so plainly rather
  // than dying on EISDIR with a stack trace.
  try {
    const st = fs.lstatSync(CHANGELOG_FILE);
    if (!st.isFile()) {
      console.error(`error: ${rel(CHANGELOG_FILE)} exists but is not a regular file — remove it and re-run.`);
      process.exit(1);
    }
  } catch (e) { /* absent: a fresh changelog is created */ }

  const newChangelog = prependToChangelog(datedSection);

  // Crash-safe ordering. The old sequence was write CHANGELOG.md, THEN unlink
  // each fragment — so a process death or a single failed unlink after the
  // write left fragments whose bullets were already published, and the next
  // run re-assembled them as duplicates with nothing to say it had happened.
  // Now: (1) refuse to start if a previous run left staging behind, (2) move
  // every fragment into staging (same-directory renames, atomic), (3) write
  // the changelog atomically via a temp file + rename, (4) remove staging.
  // Any interruption leaves either untouched fragments or a staging dir,
  // never a silent duplicate.
  // A symlinked changelog target would have prependToChangelog read THROUGH
  // it (out-of-repo content republished into the repo) while the final
  // rename replaced the link rather than writing through it. Refuse.
  // Guarded like every other refusal: a read-only or root-owned changelog.d/
  // (EACCES) or ENOSPC here must be an `error:` line, not a stack trace.
  orExit(() => fs.mkdirSync(STAGING_DIR, { recursive: true }));
  const staged = [];
  // Declared outside the try so a failed write or rename can remove it: a
  // leaked temp file in the repo root would otherwise survive every
  // EXDEV/EACCES failure. Deterministic name (no pid) so a committed symlink
  // at this path is a testable case, not a lottery.
  const tmp = `${CHANGELOG_FILE}.tmp`;
  let createdTmp = false; // set only once openSync succeeds — see the catch
  try {
    for (const f of files) {
      const dest = path.join(STAGING_DIR, path.basename(f));
      fs.renameSync(f, dest);
      staged.push([f, dest]);
    }
    // O_CREAT|O_EXCL: refuse an EXISTING path at tmp rather than write through
    // it. A PR can commit a symlink at CHANGELOG.md.tmp pointing outside the
    // checkout; a plain writeFileSync would overwrite the link's target with
    // the assembled changelog and the rename would then move the LINK onto
    // CHANGELOG.md. EEXIST lands in the catch below as a pre-publish failure.
    // A stale tmp from a killed run is refused the same way — remove it.
    const fd = fs.openSync(tmp, 'wx', 0o644);
    createdTmp = true;
    try { fs.writeFileSync(fd, newChangelog); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, CHANGELOG_FILE);
  } catch (e) {
    // Only remove tmp if WE created it. Tracked explicitly, not inferred from
    // e.code: the try also covers the staging renames, which run BEFORE tmp is
    // opened — a rename failing there (EACCES, ENOSPC, EXDEV) is not EEXIST,
    // and an error-code test would have unlinked a stale file or committed
    // symlink at this path that this run never created.
    if (createdTmp) {
      try { fs.unlinkSync(tmp); } catch (_) { /* already renamed into place */ }
    }
    // Nothing has been published: put every staged fragment back. Staging is
    // removed ONLY if every fragment made it back — an unconditional rmSync
    // here would delete a fragment that failed to move, with no copy
    // anywhere, while the message said "restored".
    const unrestored = [];
    for (const [orig, dest] of staged) {
      try { fs.renameSync(dest, orig); } catch (_) { unrestored.push(dest); }
    }
    if (unrestored.length === 0) {
      try { fs.rmSync(STAGING_DIR, { recursive: true, force: true }); } catch (_) { /* best effort */ }
      console.error(`error: close-out failed before publishing, fragments restored: ${e.message}`);
    } else {
      console.error(`error: close-out failed before publishing: ${e.message}`);
      console.error(`${unrestored.length} fragment(s) could NOT be moved back and are still in ${rel(STAGING_DIR)}/ — nothing was published; move them back by hand:`);
      for (const d of unrestored) console.error(`  - ${rel(d)}`);
    }
    process.exit(1);
  }
  try {
    fs.rmSync(STAGING_DIR, { recursive: true, force: true });
  } catch (e) {
    // The changelog IS published at this point. Say so, and leave a marker so
    // the next run reports the known answer instead of the interrupted-run
    // ambiguity this rewrite exists to remove.
    try { fs.writeFileSync(path.join(STAGING_DIR, 'PUBLISHED'), `${todayDate()}\n`); } catch (_) { /* best effort */ }
    console.error(`warning: ${rel(CHANGELOG_FILE)} is published, but ${rel(STAGING_DIR)}/ could not be removed (${e.message}). Its contents are already in the changelog — delete the directory by hand.`);
    process.exit(1);
  }

  console.log(`assembled ${files.length} fragment(s) into ${rel(CHANGELOG_FILE)} and deleted them:`);
  for (const f of files) console.log(`  - ${rel(f)}`);
}

main();
