---
name: conflict-check
description: Compare forge's actual behaviour and the repository's GitHub merge settings (read-only) with the rules the decisions log fixes — squash only, no auto-merge to main, child-branch rules, Tier 3 areas — and report every conflict in plain English. Runs when session start says the forge version changed since the last session, or when the human asks.
---

# conflict-check

Standing rule (opusjevos D-AV): while planning or building, find places where
forge, GitHub, or the repo's own files contradict a logged decision, and fix
them or report them. This skill is the scheduled form of that rule. It runs
only when it is due (D-BM), because it costs usage:

- session start printed "forge version changed since the last session", or
- the human asked for it.

It is **read-only**. It never changes GitHub settings, forge config or files;
it reports, and fixes go through the normal plan/approval route.

## 1. Collect the rules on file

Read the decisions hub (the `hubs.files` entry for decisions in
`.claude/forge.json`; it is already in session context). Pull the full entries
for the rule labels only, newest first:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/hub/hub.js" find merge ci security --hub <decisions hub path> --limit 15
```

`--hub` keeps lessons and other hubs out: only decisions are rules. A later
entry overrides an earlier one on the same point. Note each rule as
one line with its ID (example: "squash only into main, D-BC").

## 2. Read what is actually in force

1. **GitHub settings and branch rules** (read-only):
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/conflict/github-rules.js" <owner/repo> --parent feature/<any> --child claude/<any>`
   For the forge repository itself add
   `--checks "validate,forge validators,reviewer clean" --parent-checks "validate,forge validators"`.
   It reads with a logged-in `gh`, else without credentials (public repos
   only). If it cannot read a private repository, say so; never guess.
2. **forge's own behaviour**: the merge rules in the framework block
   (`templates/CLAUDE.md.framework-block`) and `.claude/forge.json`
   (`git.squashOnly`, `merge.*`, `tiers.*`).
3. **Tier 3 areas**: compare forge's T3 paths in `.claude/forge.json` with the
   Tier 3 areas the decisions log names (8 stop-and-ask areas, D-K, D-AW).

## 3. Compare and report

For every rule from step 1, state one of: **matches**, **conflict** (what the
rule says, what is in force, where), or **cannot verify** (why). Then:

- Conflicts in GitHub settings: give the exact setting and where the human
  changes it (GitHub repository Settings). The agent cannot change them.
- Conflicts in forge or the repo's files: propose the fix as a plan item.
- Report in plain English, shortest first: "N conflicts, M cannot verify",
  then the list.

## 4. Record

Add a decisions-log entry (spoke format, label `merge` or `config`) only when
the human makes a decision about a conflict. The session wrap-up records the
new `forge_version` in the handoff once this report has been given.
