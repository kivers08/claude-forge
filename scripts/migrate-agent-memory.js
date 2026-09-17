#!/usr/bin/env node
'use strict';
// memory-v2 migration (docs/plans/memory-v2.md §8, unit 1).
//
// A MECHANICAL pass that adds the memory-v2 frontmatter schema (§3.2) to the
// EXISTING .claude/agent-memory/**/*.md records WITHOUT losing their content or
// their pre-existing frontmatter. This is a script (NOT a hook), so it is
// allowed to use Date/crypto for timestamps and ids — the no-Date.now rule in
// memory.js is about hooks specifically.
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

function migrateFile(full, plugin, scope) {
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
  // Preserve the pre-existing frontmatter (name/description/metadata) verbatim
  // as `extra`, and keep the body exactly.
  const out = mem.serializeRecord({ frontmatter: fm, extra: parsed.extra, body: parsed.body });
  if (!DRY) fs.writeFileSync(full, out);
  return { full, action: DRY ? 'would-migrate' : 'migrate', type: fm.type };
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
    else { migrated++; console.log(`${r.action}  ${path.relative(REPO, r.full)} -> type:${r.type}`); }
  }
  console.log(`\n${migrated} migrated, ${skipped} skipped, ${errored} errored${DRY ? ' (dry run)' : ''}`);
  process.exit(errored ? 1 : 0);
}

main();
