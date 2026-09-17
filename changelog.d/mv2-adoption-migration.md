section: Added
- `scripts/lib/memory-migrate.js` — the memory-v2 adoption migration engine
  (D28.2/D28.4): adapts a repo's pre-existing agent memory/lessons, in any
  prior shape (plain markdown, flat/legacy frontmatter, or a mix), into the
  native `.claude/agent-memory/<plugin>-<agent>/` record format (D28.3),
  non-destructively. A pre-existing file that isn't already a valid native
  record has its pristine bytes moved (never deleted) to
  `.claude/agent-memory/_pre-migration/<scope>/…`, mirroring the source
  layout, before a new native record is written at the original path;
  already-native records are left untouched. Every write is scrubbed through
  `plugins/forge/hooks/lib/redact.js`'s `scrubSecrets`, same as
  `memory-redact.js`'s on-write scrub. Idempotent: a record is migrated only
  once (detected by the absence of `metadata.id`), so re-running the
  migration over an already-migrated tree changes nothing.
- `scripts/migrate-agent-memory.js` — the `forge memory migrate` CLI
  (`--root <dir>`, `--dry-run`). Supersedes the unit-1 seed of the same name
  (never merged; depended on the since-retired custom `lib/memory.js`
  storage engine) with a generalized, install-time capable version that
  targets any consumer repo.
- `plugins/forge/skills/memory-migrate/SKILL.md` — the skill wrapping
  `forge memory migrate`, explicit and human-run only, never invoked
  automatically from a hook or on SessionStart.
- `bootstrap`'s SKILL.md now checks for pre-existing, non-native agent memory
  during adoption and mentions `memory-migrate` as an optional next step —
  it does not run the migration itself, keeping the rewrite decision
  explicit and separate from config scaffolding.
- `scripts/tests/memory-migrate.test.js` — a fixture-repo test covering the
  full D28.2 contract: content preservation, native-format reshaping,
  pristine-original archiving under `_pre-migration/`, `MEMORY.md` index
  correctness, second-run idempotency, `--dry-run`, and secret scrubbing on
  migration. Wired into `ci.yml` alongside the other `scripts/tests/*`
  suites.
