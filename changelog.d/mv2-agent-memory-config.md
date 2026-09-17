section: Docs
- Each of the six worker agents (`reviewer`, `implementer`, `bug-fixer`,
  `test-writer`, `doc-updater`, `explorer`) now documents its native
  `memory: project` scope (D28.4): committed, team-shared, per-agent isolated
  at `.claude/agent-memory/forge-<agent>/`, with writes scrubbed by the
  redaction hook before disk. For `reviewer` only, additionally notes that
  during CI review its memory is read from the BASE ref to prevent a PR from
  planting a lesson that steers its own review (see `scripts/reviewer-clean-check.js`).
