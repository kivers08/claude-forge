---
name: memory-migrate
description: Adapt a repo's pre-existing agent memory/lessons (any prior shape) into the native memory-v2 record format (D28.3), non-destructively — archives every pristine original, never deletes or overwrites content, idempotent on re-run. Run explicitly at adoption (offered by `bootstrap`) or whenever a repo's `.claude/agent-memory/**` predates memory-v2.
---

# memory-migrate

`forge memory migrate` — the D28.2 adoption migration. Adapts a repository's
existing agent memory into the native `.claude/agent-memory/<plugin>-<agent>/`
record format (D28.3: `name`/`description` top-level, `metadata.type` etc.
nested), whatever shape it was in before (plain markdown lessons, flat
frontmatter, a different prior schema, or a mix). Distinct from `bootstrap`,
which scaffolds a NEW project's forge config — this skill instead reshapes
memory that already exists.

**Explicit, never silent (D28.2).** This skill runs only when a human asks
for it directly, or accepts the offer `bootstrap` makes when it notices
non-native memory during adoption. It is never invoked automatically on
SessionStart or from any hook — rewriting a repo's committed files is a
deliberate, visible act, not standing policy.

## The Bluegrass rule (non-destructive guarantee)

Content is never lost:

- A file that is not already a valid native record (no `metadata.id`) is
  never edited in place. Its pristine bytes are **moved** — never deleted —
  to `.claude/agent-memory/_pre-migration/<scope>/<original path>`, mirroring
  the source layout, before a new native record is written at the original
  location.
- A file that is already a valid native record is left completely untouched
  and is not archived — there is nothing to migrate.
- Every write runs through the same secret/PII scrubber
  (`plugins/forge/hooks/lib/redact.js`'s `scrubSecrets`) that
  `memory-redact.js` uses on every native memory write, so a credential
  sitting in an already-committed lesson file cannot survive migration
  unredacted. The archived original in `_pre-migration/` is intentionally
  **not** scrubbed — it is a pristine snapshot of what existed before.
- Re-running the migration is a no-op: a record is only ever migrated once
  (detected by the absence of `metadata.id`), so a second run neither
  re-archives nor re-writes anything already native.

## Process

1. Run `node ${CLAUDE_PLUGIN_ROOT}/../../scripts/migrate-agent-memory.js
   --root <repo-root>` (or, inside this plugin's own repo,
   `node scripts/migrate-agent-memory.js`). Add `--dry-run` first if the
   human wants to preview what would change before committing to it.
2. Review the output: for each file, `migrate` (with a redaction count if
   any secret was scrubbed), `skip` (already native), or `error` — an unsafe
   plugin/scope directory name, a file too large to migrate (over the
   engine's size cap, left untouched), or a file that could not be read
   (permissions, or removed mid-run) — every `error` is surfaced, never
   guessed past. Every `index-updated` line means that scope's `MEMORY.md`
   gained an entry for a record that wasn't indexed yet.
3. Diff the result like any other change to committed files — the migrated
   records, the new `_pre-migration/` archive, and any updated `MEMORY.md`
   are all ordinary tracked files. A poisoned or wrongly-typed record is
   caught here, not silently trusted.
4. Report what was migrated, what was skipped and why, and point at
   `_pre-migration/` as where the untouched originals now live. If the CLI
   printed a closing `WARNING` about redacted secrets, surface it verbatim —
   there are two distinct cases and the CLI names the right location for
   each: a redaction from a record this run migrated points at its pristine
   original under `_pre-migration/` (intentionally **not** scrubbed, so it
   still holds the raw secret at a newly-committed path); a redaction that
   came only from indexing an already-native record's title/description (or
   a pre-existing MEMORY.md hub line) was NEVER archived — the Bluegrass rule
   leaves that record untouched — so the WARNING instead names the LIVE
   record (or MEMORY.md) path where the raw secret still sits. Either way,
   the human should review the named location(s) (and consider rotating the
   credential, or excluding an archived file from version control) before
   committing.

## When `bootstrap` should offer this

If `bootstrap` finds an existing `.claude/agent-memory/` (or an
equivalent lessons/memory location the project describes) that predates
memory-v2 — i.e. records without `metadata.id` — it should mention this
skill as an optional next step, not run it itself. Adoption migration is a
separate, explicit decision from scaffolding a fresh `forge.json`.
