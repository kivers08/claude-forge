---
name: audit
description: General project-health audit — task-file caps, delegation misses, zero-use mechanisms (D10), and anything else that's drifted from how the project is supposed to run. Writes a dated report to taskFiles.auditsDir. Distinct from audit-framework, which checks the forge plugin's own contracts specifically.
---

# audit

A broader health check than `audit-framework` (which is scoped to forge's own
structural contracts — see that skill). `audit` looks at how the project is
actually being worked, using what telemetry and the task files already show.

## Checks

1. **Task file caps.** Compare `tasks/lessons.md`, the todo file, the sprint
   file, and each memory spoke against `taskFiles.caps`. Report any file over
   its cap — this is a signal for `session-wrap-up` to demote/consolidate,
   not something this skill fixes itself.
2. **Zero-use mechanisms (D10).** Read `${CLAUDE_PLUGIN_DATA}/telemetry.jsonl`
   and list any skill, agent, or guard with no recorded use over a
   meaningful window (the report states the window it checked). Count only
   `event: "invocation"` rows toward use; `event: "unit_complete"` rows are
   per-dispatch completion records written by the SubagentStop hook, not a
   second invocation of the same agent, and must not be double-counted. This
   is a list for the human to prune from, not an automatic removal.
3. **Delegation drift.** Check whether `delegation.inlineAllow` /
   `delegation.delegatedPaths` still reflect reality — e.g. a path that's
   been inline-edited repeatedly despite being marked `delegatedPaths`, per
   the `delegation` guard's reminder log in telemetry.
4. **Stale precondition language**, same pattern `audit-framework` checks in
   the plugin's own files, but here scoped to the project's own task files
   and CLAUDE.md: "until X", "because Y doesn't", "kept because" phrasing
   whose condition should be re-verified.
5. **Anything the dispatch prompt asks for specifically** — this skill takes
   an optional scope argument; when given, add that check to the list above
   rather than replacing the standard checks.

## Report

Write a dated report to `taskFiles.auditsDir` (repo-relative directory from
`.claude/forge.json`). Each finding: what was checked, what was found, and a
suggested action — never an automatic fix. State plainly when a check found
nothing to report, so the report reads as complete rather than partial.
