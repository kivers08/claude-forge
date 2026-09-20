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
  migration over an already-migrated tree changes nothing. Serialized
  frontmatter scalars are quoted whenever a real, standards-compliant YAML
  parser (not just this engine's own minimal reader) would otherwise
  misread the value's type or truncate it — e.g. a fully-redacted
  `[REDACTED:...]` name (would parse as a one-element list) or a value
  containing ` #` (would truncate at an unintended comment) — so a migrated
  record stays correctly readable by native Claude Code and any other YAML
  tool, not just by this engine's own parser.
- `scripts/migrate-agent-memory.js` — the `forge memory migrate` CLI
  (`--root <dir>`, `--dry-run`). Supersedes the unit-1 seed of the same name
  (never merged; depended on the since-retired custom `lib/memory.js`
  storage engine) with a generalized, install-time capable version that
  targets any consumer repo. When a run redacts a secret, the closing
  WARNING names the exact location(s) where the raw value still lives: a
  record this run migrated points at its pristine (intentionally
  unscrubbed) original under `_pre-migration/`; a redaction that came only
  from indexing an already-native record's title/description, or from a
  pre-existing `MEMORY.md` hub line, was never archived (the Bluegrass rule
  leaves it untouched) and the WARNING instead names that live path.
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
  correctness, second-run idempotency, `--dry-run`, secret scrubbing on
  migration, YAML-real-parser-safe scalar quoting, and accurate redaction
  WARNING provenance (archived vs. live-untouched). Wired into `ci.yml`
  alongside the other `scripts/tests/*` suites.
