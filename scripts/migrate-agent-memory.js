#!/usr/bin/env node
'use strict';
// forge memory migrate (docs/plans/memory-v2.md D28.2/D28.4, unit 4).
//
// Thin CLI wrapper over scripts/lib/memory-migrate.js's engine: adapts a
// repo's pre-existing `.claude/agent-memory/**` files — in ANY prior shape,
// including a repo adopting forge for the first time — into the native
// memory-v2 record format (D28.3), non-destructively.
//
// This supersedes the original unit-1 seed of the same name (which lived on
// the never-merged claude/mv2-u1-record-schema branch and depended on the
// since-retired plugins/forge/hooks/lib/memory.js custom storage engine —
// see docs/plans/memory-v2.md D28.4's "DROP" list). That seed only added
// frontmatter to THIS repo's own already-mostly-native files in place; this
// version generalizes it into forge's actual install-time adoption-migration
// capability: it archives every pristine pre-migration original (never
// deletes), is idempotent, and is meant to run against any consumer repo,
// not just this one.
//
// EXPLICIT, NEVER SILENT (D28.2): this script rewrites a repo's committed
// files. It is a human-run command (`forge memory migrate` — wired into the
// `bootstrap` skill as a suggested next step, see
// plugins/forge/skills/memory-migrate/SKILL.md) and is NEVER invoked
// automatically from a hook or on SessionStart.
//
// Usage:
//   node scripts/migrate-agent-memory.js [--dry-run] [--root <dir>]
// FORGE_REPO_ROOT (or --root) points at the target repo; defaults to the
// current working directory (NOT one level up from this script — a consumer
// repo runs this against ITSELF, typically via a copy of this file or the
// plugin's own script path with --root pointed at the adopting project).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const engine = require('./lib/memory-migrate');

function main(argv) {
  const args = argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const rootIdx = args.indexOf('--root');
  const rootArg = rootIdx !== -1 ? args[rootIdx + 1] : null;
  const root = path.resolve(rootArg || process.env.FORGE_REPO_ROOT || process.cwd());

  if (!fs.existsSync(root)) {
    console.error(`error: root does not exist: ${root}`);
    return 1;
  }

  const now = new Date().toISOString(); // stamped once, here, by the CLI process — never inside the library
  const { results, memRootExists } = engine.migrateRepo(root, {
    dryRun,
    now,
    nextId: () => crypto.randomUUID(),
  });

  if (!memRootExists) {
    console.log(`no ${engine.AGENT_MEMORY_DIRNAME} directory at ${root} — nothing to migrate`);
    return 0;
  }

  let migrated = 0;
  let skipped = 0;
  let errored = 0;
  let indexed = 0;
  for (const r of results) {
    if (r.action === 'error') {
      errored++;
      console.error(`ERROR ${r.file}: ${r.reason}`);
    } else if (r.action === 'skip') {
      skipped++;
      console.log(`skip  ${r.file} (${r.reason})`);
    } else if (r.action === 'index-updated') {
      indexed++;
      console.log(`index ${r.file} updated`);
    } else {
      migrated++;
      const red = r.redactions ? ` (redacted ${r.redactions})` : '';
      console.log(`${r.action}  ${r.file} -> type:${r.type}${red}`);
    }
  }
  console.log(`\n${migrated} migrated, ${skipped} skipped, ${errored} errored, ${indexed} index(es) updated${dryRun ? ' (dry run)' : ''}`);
  return errored ? 1 : 0;
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = { main };
