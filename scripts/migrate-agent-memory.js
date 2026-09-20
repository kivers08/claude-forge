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
  let rootArg = null;
  if (rootIdx !== -1) {
    const next = args[rootIdx + 1];
    // `--root` with no following value, or a value that itself looks like
    // another flag (e.g. `forge memory migrate --root --dry-run`, or a
    // simple typo like `--root` at the end of the line), must fail LOUDLY
    // rather than silently falling back to process.cwd() — this command
    // rewrites a repo's committed files (D28.2: "never silent"), so a typo
    // must never result in rewriting the wrong (current) repo.
    if (next === undefined || next.startsWith('-')) {
      console.error('error: --root requires a directory path argument (got none)');
      return 1;
    }
    rootArg = next;
  }
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
  let totalRedactions = 0;
  let migratedRedactions = 0; // EXACT count of redactions whose raw original is archived under _pre-migration/
  const nativeRedactedPaths = []; // [{ path, count }] — LIVE paths whose raw secret was never archived (SECURITY 3)
  for (const r of results) {
    if (r.action === 'error') {
      errored++;
      console.error(`ERROR ${r.file}: ${r.reason}`);
    } else if (r.action === 'skip') {
      skipped++;
      console.log(`skip  ${r.file} (${r.reason})`);
    } else if (r.action === 'index-updated') {
      indexed++;
      totalRedactions += r.redactions || 0;
      // `r.migratedRedactions` and `r.nativeRedactedPaths[].count` are exact,
      // pre-attributed counts from migrateScopeDir (per-file, never a file
      // count subtracted from a redaction count) — an index-updated result's
      // redactions come from indexing newly-migrated records (archived) as
      // well as already-native records/carry-through hub lines (never
      // archived), and this module trusts the engine's exact attribution
      // rather than re-deriving it approximately here.
      migratedRedactions += r.migratedRedactions || 0;
      nativeRedactedPaths.push(...(r.nativeRedactedPaths || []));
      const red = r.redactions ? ` (redacted ${r.redactions})` : '';
      console.log(`index ${r.file} updated${red}`);
    } else {
      migrated++;
      totalRedactions += r.redactions || 0;
      migratedRedactions += r.redactions || 0; // this action's raw original is always archived under _pre-migration/
      const red = r.redactions ? ` (redacted ${r.redactions})` : '';
      const archiveNote = r.archivedAt && path.basename(r.archivedAt) !== path.basename(r.file)
        ? ` [archived as ${r.archivedAt} — a prior archive already occupied the default path]`
        : '';
      console.log(`${r.action}  ${r.file} -> type:${r.type}${red}${archiveNote}`);
    }
  }
  console.log(`\n${migrated} migrated, ${skipped} skipped, ${errored} errored, ${indexed} index(es) updated${dryRun ? ' (dry run)' : ''}`);
  if (totalRedactions > 0 && !dryRun) {
    // Two DIFFERENT things can be true about where a redacted secret's raw
    // value still lives on disk, and this run may have BOTH at once
    // (SECURITY 3):
    //   - `migratedRedactions`: the secret was in a record THIS run migrated
    //     (or in re-indexing one), whose pristine original is archived —
    //     never scrubbed — under `.claude/agent-memory/_pre-migration/`.
    //   - `nativeRedactedPaths`: the secret was in an already-native
    //     record's title/hook/FILENAME, picked up only while building the
    //     MEMORY.md index entry for it (or in a pre-existing hub line
    //     itself). The Bluegrass rule means an already-native record is
    //     NEVER archived, so that raw secret was never moved anywhere — it
    //     still sits in the LIVE record (or the live MEMORY.md) at its
    //     original path.
    // Pointing every warning at `_pre-migration/` regardless of which case
    // applies would send a human looking in the archive for a secret that
    // was never archived at all, leaving it live and unreviewed.
    if (migratedRedactions > 0) {
      console.log(
        `\nWARNING: ${migratedRedactions} secret(s)/PII value(s) were redacted from LIVE migrated record(s), ` +
          `but the pristine original(s) in .claude/agent-memory/_pre-migration/ are intentionally NOT scrubbed and ` +
          `still contain the raw value(s). Review that archive before committing — consider removing the ` +
          `archived original(s) from version control, or rotating the exposed credential(s), if they should not ` +
          `be preserved in git history.`
      );
    }
    if (nativeRedactedPaths.length > 0) {
      const totalNativeRedactions = nativeRedactedPaths.reduce((sum, p) => sum + (p.count || 0), 0);
      const list = nativeRedactedPaths.map((p) => `  - ${p.path} (${p.count})`).join('\n');
      console.log(
        `\nWARNING: ${totalNativeRedactions} secret(s)/PII value(s) were redacted only from the MEMORY.md ` +
          `index entry text, but the LIVE record(s) below were left untouched by design (already native, or a ` +
          `pre-existing hub line) and still contain the raw value(s) at their original path(s):\n${list}\n` +
          `Review and rotate the exposed credential(s) there before committing. If a path above is itself the ` +
          `file's NAME (not just its contents), rename the file and rotate the credential — the filename is ` +
          `visible in the committed MEMORY.md link target even though its text was left unscrubbed by design.`
      );
    }
  }
  return errored ? 1 : 0;
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = { main };
