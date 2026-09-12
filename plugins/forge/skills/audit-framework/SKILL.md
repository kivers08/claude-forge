---
name: audit-framework
description: Validate the forge framework's own structural contracts in this project — index/body sync (D6), CLAUDE.md framework-block drift against the plugin's canonical copy (D5), stale-precondition language, forge.json against its schema, zero-use telemetry (D10), changelog fragment shape (D21), and changed files falling through every risk tier (D17). Run before merging framework-level (T1) changes and periodically otherwise.
---

# audit-framework

Checks that forge's own machinery is internally consistent in this project —
distinct from `audit`, which checks how the project is being worked day to
day. Every check below is a structural comparison, not a judgment call; each
either passes or names exactly what's wrong and where.

## Checks

1. **Index/body sync (D6).** For every grep-only file (`taskFiles.lessons`,
   `taskFiles.todo`, and any archive), confirm every `## Index` line's anchor
   string (`grep "<anchor>"`) appears verbatim exactly once in the file's
   body, and every body entry has a corresponding index line. Report both
   directions of mismatch — an index line with no matching body anchor, and
   a body entry missing from the index.
2. **CLAUDE.md framework-block drift (D5).** Diff the project's CLAUDE.md
   marker-delimited framework block against the plugin's own canonical copy
   (the block `bootstrap` writes from). Report any divergence line-by-line —
   this catches hand-edits that will be silently overwritten by a future
   `bootstrap` re-run, or drift that means the project is running on
   out-of-date coordinator rules.
3. **Stale-precondition grep.** Search the project's task files and CLAUDE.md
   for "until X", "because Y doesn't", "kept because" phrasing (and close
   variants). Each hit is a candidate whose stated condition should be
   re-verified — report the line and quote the condition; don't
   auto-resolve it.
4. **`forge.json` vs. schema.** Validate the project's `.claude/forge.json`
   against `plugins/forge/schema/forge.schema.json` — same validation
   `bootstrap` runs once at write time, re-run here to catch schema drift
   after manual edits (unknown keys, missing `additionalProperties`
   compliance is the plugin's own concern, not the instance's — here it's
   about the instance actually conforming to the shipped schema).
5. **Zero-use telemetry (D10).** Same telemetry source as `audit`'s check,
   but framed as a framework question here: does every configured guard,
   skill, and agent show at least one recorded use? A mechanism with zero
   uses over a meaningful window is a candidate for the human to prune —
   list it, don't remove it.
6. **Changelog fragment shape (D21).** Every file in `changelog.fragmentsDir`
   must have a `section: <name>` line followed by one or more `-` bullets,
   matching `changelog.d/README.md`'s documented format. Report any fragment
   that doesn't parse as that shape.
7. **Tier fallthrough (D17).** For the PR/branch under audit, run
   `git diff <base>...HEAD --name-only` and check every changed path against
   `tiers.T0`–`tiers.T3`. Report any file matching no tier — it silently
   defaults to T2, which may or may not be the intended risk level; surface
   it rather than letting it pass unnoticed.

## Report

One line per check: pass, or a list of specific mismatches with file/line
references. End with a summary count (N/7 checks clean). This skill never
edits files to fix what it finds — every result here is the human's or a
dispatched agent's to act on, the same way `reviewer`'s findings are never
self-applied.
