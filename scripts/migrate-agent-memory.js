#!/usr/bin/env node
'use strict';
// memory-v2 migration (docs/plans/memory-v2.md §8, unit 1) — SAFE SEED ONLY.
//
// A MECHANICAL pass that adds the memory-v2 frontmatter schema (§3.2) to the
// EXISTING .claude/agent-memory/**/*.md records WITHOUT losing their content or
// their pre-existing frontmatter. This is a script (NOT a hook), so it is
// allowed to use Date/crypto for timestamps and ids — the no-Date.now rule in
// memory.js is about hooks specifically.
//
// NOT RUN as part of unit 1 (D28.2): adoption migration is EXPLICIT — a human
// runs it deliberately at adoption, never silently on SessionStart. Unit 1 does
// NOT auto-migrate this repo; this script is the safe seed the full
// archive-model adoption migration (unit 8) generalizes.
//
// TODO(unit 8, D28.2): archive-model + explicit adoption. This in-place-additive
// seed must be generalized to: move the PRISTINE original to
// `.claude/agent-memory/_pre-migration/<scope>/` (never delete), be idempotent,
// and run only via the `bootstrap` skill / `forge memory migrate` command a
// human invokes — not automatically.
//
// Every write here runs through the same scrubSecrets path memory.js uses on
// every write (plan §3.4: "Every write runs the redaction scrubber first"), so
// a secret sitting in an already-committed file cannot survive migration
// unredacted.
//
// Design decisions (documented here because the diff alone won't explain them):
//
//   * MEMORY.md files are INDEXES, not records (§8: "the new index is a machine
//     sidecar, not a replacement for the ## Index section"). They get NO
//     frontmatter and are left byte-for-byte untouched.
//
//   * Existing records already carry a `name`/`description`/`metadata` block
//     from the persistent-agent-memory system. That is a DIFFERENT schema from
//     memory-v2's. We PRESERVE those keys verbatim (they ride along in the
//     parser's `extra`) and ADD the memory-v2 fields alongside them. Nothing is
//     removed — lossless, reversible via git.
//
//   * `type` mapping: the existing files use metadata.type values of `project`
//     and `feedback`, which are NOT in memory-v2's small set (fact|lesson|
//     decision|note). We map by intent, not by string:
//       - security/behavioral "we learned X the hard way" records -> `lesson`
//       - everything else (project state, feedback) -> `note`
//     A human reviewer can retype any record later; `note` is the safe default
//     when in doubt (§3.2: adding/retyping is cheap).
//
//   * `scope` comes from the directory name (`forge-<scope>`), the D4 source of
//     truth — never guessed.
//
//   * ids: generated once here (crypto.randomUUID) and then STABLE — a re-run
//     that finds an already-migrated file (one that already has an `id`) leaves
//     it untouched, so the migration is idempotent and re-running never churns
//     ids or timestamps.
//
// Usage:
//   node scripts/migrate-agent-memory.js [--dry-run] [--root <dir>]
// FORGE_REPO_ROOT (or --root) points at the repo; defaults to one level up.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mem = require('../plugins/forge/hooks/lib/memory');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const rootArg = argv.includes('--root') ? argv[argv.indexOf('--root') + 1] : null;
const REPO = path.resolve(rootArg || process.env.FORGE_REPO_ROOT || path.join(__dirname, '..'));
const MEM_ROOT = path.join(REPO, '.claude', 'agent-memory');

// Records whose content is a "we learned this the hard way" lesson map to
// `lesson`; everything else to `note`. Keyed by filename slug for the known
// pre-existing set; unknown files fall through to the heuristic.
const KNOWN_LESSON_SLUGS = new Set([
  'security_hasUnquotedSequence_bypass',
  'flag_semantics_claude_cli',
  'headless_reviewer_git_commentary',
  'feedback_local_testing_scope',
]);

function classifyType(fileSlug, extra) {
  if (KNOWN_LESSON_SLUGS.has(fileSlug)) return 'lesson';
  const mt = (extra && typeof extra.metadata === 'string') ? extra.metadata : '';
  // metadata rides as a multiline block; a `type: feedback` inside it hints a
  // behavioral lesson.
  if (/type:\s*feedback/.test(mt)) return 'lesson';
  return 'note';
}

function nowIso() {
  return new Date().toISOString();
}

function scopeFromDir(dirName) {
  // dirName is like `forge-implementer` -> scope `implementer`, plugin `forge`.
  const idx = dirName.indexOf('-');
  if (idx === -1) return { plugin: 'forge', scope: dirName };
  return { plugin: dirName.slice(0, idx), scope: dirName.slice(idx + 1) };
}

function migrateFile(full, plugin, scope, dry = DRY) {
  const raw = fs.readFileSync(full, 'utf8');
  const parsed = mem.parseRecord(raw);
  // Already migrated? (has a memory-v2 id) -> idempotent no-op.
  if (parsed.frontmatter && parsed.frontmatter.id) {
    return { full, action: 'skip', reason: 'already has id' };
  }
  const slug = path.basename(full, '.md');
  const created = nowIso();
  const fm = {
    id: crypto.randomUUID(),
    type: classifyType(slug, parsed.extra),
    scope,
    tier: 'semantic', // hand-authored, curated records are durable knowledge
    importance: 0.5,
    created,
    lastUsed: null,
    uses: 0,
    source: 'authored', // these were written by a human/agent explicitly
    supersedes: null,
  };
  // Scrub before write, same as memory.js's writeRecord (plan §3.4): the body,
  // each string frontmatter value, and every string nested in the preserved
  // `extra` (name/description/metadata). A secret in an already-committed file
  // must not survive migration unredacted.
  const redactions = [];
  const scrubbedBody = mem.scrubValueDeep(parsed.body, redactions);
  for (const k of Object.keys(fm)) {
    if (typeof fm[k] === 'string') fm[k] = mem.scrubValueDeep(fm[k], redactions);
  }
  const scrubbedExtra = mem.scrubValueDeep(parsed.extra, redactions);
  // Preserve the pre-existing frontmatter (name/description/metadata) as `extra`,
  // and keep the (scrubbed) body.
  const out = mem.serializeRecord({ frontmatter: fm, extra: scrubbedExtra, body: scrubbedBody });
  if (!dry) fs.writeFileSync(full, out);
  return { full, action: dry ? 'would-migrate' : 'migrate', type: fm.type, redactions: redactions.length };
}

function main() {
  let dirs;
  try {
    dirs = fs.readdirSync(MEM_ROOT);
  } catch (e) {
    console.error(`no agent-memory at ${MEM_ROOT}: ${e.message}`);
    process.exit(0);
  }
  const results = [];
  for (const dirName of dirs) {
    const dirPath = path.join(MEM_ROOT, dirName);
    let st;
    try { st = fs.statSync(dirPath); } catch (e) { continue; }
    if (!st.isDirectory()) continue;
    const { plugin, scope } = scopeFromDir(dirName);
    for (const name of fs.readdirSync(dirPath)) {
      if (name === 'MEMORY.md') continue; // index, not a record — left untouched
      if (name === mem.ARCHIVE_DIR) continue;
      if (!name.endsWith('.md')) continue;
      const full = path.join(dirPath, name);
      try {
        results.push(migrateFile(full, plugin, scope));
      } catch (e) {
        results.push({ full, action: 'error', reason: e.message });
      }
    }
  }
  let migrated = 0, skipped = 0, errored = 0;
  for (const r of results) {
    if (r.action === 'error') { errored++; console.error(`ERROR ${r.full}: ${r.reason}`); }
    else if (r.action === 'skip') { skipped++; console.log(`skip  ${path.relative(REPO, r.full)} (${r.reason})`); }
    else {
      migrated++;
      const red = r.redactions ? ` (redacted ${r.redactions})` : '';
      console.log(`${r.action}  ${path.relative(REPO, r.full)} -> type:${r.type}${red}`);
    }
  }
  console.log(`\n${migrated} migrated, ${skipped} skipped, ${errored} errored${DRY ? ' (dry run)' : ''}`);
  process.exit(errored ? 1 : 0);
}

// Run only when invoked directly (node scripts/migrate-agent-memory.js). When
// require()'d by a test, expose the pure helpers so the migration can be
// exercised against a TEMP fixture dir — never the repo's real files.
if (require.main === module) {
  main();
}

module.exports = { migrateFile, classifyType, scopeFromDir };
