#!/usr/bin/env node
'use strict';
// memory-v2 migration (docs/plans/memory-v2.md §8, unit 1) — SAFE SEED ONLY.
//
// A MECHANICAL pass that adds the memory-v2 frontmatter schema (§3.2/D28.3) to
// the EXISTING .claude/agent-memory/**/*.md records WITHOUT losing their
// content or their pre-existing frontmatter. This is a script (NOT a hook), so
// it is allowed to use Date/crypto for timestamps and ids — the no-Date.now
// rule in memory.js is about hooks specifically.
//
// D28.3 shape: `name`/`description` stay top-level (Anthropic fields); every
// forge operational field is emitted under a nested `metadata:` block.
//
// NOT RUN as part of unit 1 (D28.2): adoption migration is EXPLICIT — a human
// runs it deliberately at adoption, never silently on SessionStart. Unit 1 does
// NOT auto-migrate this repo; this script is the safe seed the full
// archive-model adoption migration (unit 8) generalizes.
//
// This script is a SAFE SEED for unit 1 ONLY, deliberately narrower than the
// full D28.2 adoption path. The following are KNOWN, DEFERRED gaps (a CI
// review pass flagged them; they are not implemented here on purpose — see
// TASK 7 of the unit 1 hardening dispatch):
//   * it does not archive the PRISTINE original file before mutating it;
//   * it writes in place rather than via memory.js's atomic tmp+rename;
//   * it does not validate the plugin/scope directory segments it derives
//     against memory.js's SEGMENT_RE before using them.
// All three, plus test coverage for main()/dry-run, land in unit 8 alongside
// the archive-model rewrite below — see the TODO immediately following.
//
// TODO(unit 8, D28.2): archive-model + explicit adoption. This in-place-additive
// seed must be generalized to: move the PRISTINE original to
// `.claude/agent-memory/_pre-migration/<scope>/` (never delete), write via an
// atomic tmp+rename (matching memory.js's writeRecord), validate every
// plugin/scope segment against SEGMENT_RE before deriving a path from it, be
// idempotent, and run only via the `bootstrap` skill / `forge memory migrate`
// command a human invokes — not automatically.
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
//     from the persistent-agent-memory system — this is ALREADY the Anthropic
//     native shape D28.3 adopted as memory-v2's own top level. We PRESERVE
//     `name`/`description` verbatim and reuse a pre-existing `metadata.type`
//     directly per the D28.3 migration mapping: `feedback->feedback`,
//     `project->project`, `user->user`, `reference->reference` (carried
//     through as-is — all four are already in the new TYPES set). A file with
//     no recognized `metadata.type` at all falls back to `project` (the safe
//     default for "some pre-existing state/context note", §3.2: retyping is
//     cheap). Nothing is removed — lossless, reversible via git.
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

// D28.3 migration mapping: a pre-existing `metadata.type` in the Anthropic set
// carries straight through (it's already valid memory-v2). Anything else
// (missing, or a value outside the new TYPES set) falls back to `project` —
// the safe default for "some pre-existing state/context note" (§3.2: adding/
// retyping a type later is cheap).
const CARRY_THROUGH_TYPES = new Set(['user', 'feedback', 'project', 'reference']);

function classifyType(existingMetadata) {
  const t = existingMetadata && existingMetadata.type;
  if (CARRY_THROUGH_TYPES.has(t)) return t;
  return 'project';
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
  const existingMetadata = (parsed.frontmatter && parsed.frontmatter.metadata) || {};
  // Already migrated? (metadata.id already stamped) -> idempotent no-op.
  if (existingMetadata.id) {
    return { full, action: 'skip', reason: 'already has metadata.id' };
  }
  const created = nowIso();
  const name = typeof parsed.frontmatter.name === 'string' && parsed.frontmatter.name
    ? parsed.frontmatter.name
    : path.basename(full, '.md');
  const description = typeof parsed.frontmatter.description === 'string' && parsed.frontmatter.description
    ? parsed.frontmatter.description
    : name;
  const type = classifyType(existingMetadata);
  const metadata = {
    // Preserve any unrecognized pre-existing metadata sub-keys losslessly
    // (e.g. a migration from a still-different prior shape), BEFORE the
    // canonical fields below so type/scope/id/etc. always win over a
    // same-named pre-existing key.
    ...existingMetadata,
    type,
    scope,
    id: crypto.randomUUID(),
    tier: 'semantic', // hand-authored, curated records are durable knowledge
    importance: 0.5,
    created,
    lastUsed: null,
    uses: 0,
    source: 'authored', // these were written by a human/agent explicitly
    supersedes: null,
  };
  // Scrub before write, same as memory.js's writeRecord (plan §3.4): the body,
  // `name`, `description`, every string-valued `metadata` field (except the
  // freshly-generated `id`), and every string nested in `extra`. A secret in
  // an already-committed file must not survive migration unredacted.
  const redactions = [];
  const scrubbedBody = mem.scrubValueDeep(parsed.body, redactions);
  const scrubbedName = mem.scrubValueDeep(name, redactions);
  const scrubbedDescription = mem.scrubValueDeep(description, redactions);
  for (const k of Object.keys(metadata)) {
    if (k === 'id') continue;
    if (typeof metadata[k] === 'string') metadata[k] = mem.scrubValueDeep(metadata[k], redactions);
  }
  const scrubbedExtra = mem.scrubValueDeep(parsed.extra, redactions);
  const out = mem.serializeRecord({
    frontmatter: { name: scrubbedName, description: scrubbedDescription, metadata },
    extra: scrubbedExtra,
    body: scrubbedBody,
  });
  if (!dry) fs.writeFileSync(full, out);
  return { full, action: dry ? 'would-migrate' : 'migrate', type: metadata.type, redactions: redactions.length };
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
