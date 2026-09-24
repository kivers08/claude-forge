---
name: session-wrap-up
description: Close out a work session — promote genuinely new lessons into tasks/lessons.md, demote stale/superseded ones to the archive with equal rigor, refresh open-items in the todo file, and check line caps. Use at the end of a session or unit of work, before the coordinator hands off.
---

# session-wrap-up

Closes out working state. Promotion and demotion are **equal-standing steps**
here, not a promotion pass with an occasional cleanup afterthought — a
lessons file that only grows is as broken as one that never gets curated.
Skipping demotion because "there's no time" is not an option this skill
offers; do both or explicitly report which you deferred and why.

## 1. Gather what happened

Read the `### LEARNING` blocks **and the `### MEMORY PROPOSAL` blocks** from
every agent dispatched this session (or since the last wrap-up). Each LEARNING
block with `mistake: <slug>` (not `none`) is a candidate for promotion (step
3). Each MEMORY PROPOSAL block with `propose: yes` is a candidate for the
curate step (step 2). The `### OUTCOME` block is metadata for the parallel
tallying unit — you do not persist it here.

## 2. Curate MEMORY PROPOSAL blocks (propose→curate→commit)

This is the MEMORY PROPOSAL counterpart to promote/demote below: agents
**never self-write** memory — they only propose, and the main context is the
**sole writer**. Walk each `### MEMORY PROPOSAL` with `propose: yes` gathered
in step 1 and commit its `lesson` to the destination named by its `scope`:

- `agent-spoke` → the proposing agent's native-layout memory file
  (`.claude/agent-memory/<agent>/MEMORY.md`, per the project's `memory` config
  in `.claude/forge.json` — D28 native per-agent layout).
- `rule` → a rules file (`.claude/rules/*.md`), matched to the lesson's path
  signature.
- `hub` → the lessons hub (the project's `taskFiles.lessons`), written as one
  line with an `## Index` entry per the Index Contract (D6), exactly as the
  promote step formats a lesson.

**Respect `memory.excludeFromWrite`** (from `.claude/forge.json`'s `memory`
block): for any agent named there, **skip its proposals entirely — never
persist them**, regardless of `scope`. This is the compliance carve-out for
sensitive agents.

A proposal with `propose: no` (or no proposal) needs no action. Before
committing a proposal, apply the same not-a-duplicate check the promote step
uses: grep the destination for the same topic first and extend an existing
entry rather than duplicating. Report each proposal you committed, and each one
you skipped (with the reason: `excludeFromWrite`, duplicate, or `propose: no`).

## 3. Promote

For each real candidate:
- Confirm it's genuinely new — grep `taskFiles.lessons` for the same topic
  first; if an existing entry already covers it, extend that entry instead
  of duplicating.
- Write it as one line matching the project's lesson format, with an
  `## Index` line per the Index Contract (D6):
  `- [YYYY-MM-DD] <one-line summary> → grep "<anchor>"`, and the anchor
  string appearing verbatim exactly once in the body.
- Do not promote something that was already an isolated mistake corrected
  within the same dispatch with no recurring pattern — that's noise, not a
  lesson.

## 4. Demote — with the same rigor as promotion

Walk the existing lessons file (grep the `## Index`, don't read it whole —
`readDiscipline` applies here too) and, for each entry, ask: is this still
true and still relevant to how the project works today? Demote (move to the
configured archive) any entry that is:
- Superseded by a later decision or a later entry that covers the same
  ground more precisely.
- No longer applicable (the code/pattern it warns about was removed or
  replaced).
- Stale enough that `/forge:audit-framework`'s stale-precondition check would
  flag it ("until X", "because Y doesn't", "kept because" language whose
  condition has since changed).

Demoting is a content-preserving move, not a deletion: the archive keeps the
full entry, just out of the active grep-only file, so a stale rule doesn't
keep costing everyone who greps it. If nothing merits demotion this session,
say so explicitly rather than silently skipping the step — the report should
show demotion was actually considered.

## 5. Refresh the todo file

Update open-items (checkboxes) to reflect what actually got done this
session — check off completed items, don't leave the injected view stale for
the next session-start.

## 6. Check caps

Compare each task file's line count against `taskFiles.caps` (lessons, todo,
sprint, spoke). If a file is over cap, that's a signal more demotion or
consolidation is needed — report it even if you don't fix it in this pass.

## 7. Report

Summarize: what MEMORY PROPOSALs were committed and where (and which were
skipped, with the reason — `excludeFromWrite`, duplicate, or `propose: no`),
what was promoted, what was demoted (or why nothing was), any cap overages, and
any lesson candidate you chose NOT to promote and why.
