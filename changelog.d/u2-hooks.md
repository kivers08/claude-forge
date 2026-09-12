section: Added
- U2 hook unit: PreToolUse Bash guard dispatcher with a declarative manifest and
  nine guards (merge-gate, user-level-write, pr-create, git-refspec,
  worktree-commit, csv-parse, ci-owned-command, slow-command, delegation)
- Merge gate extended to the Edit/Write tools and to
  `mcp__github__merge_pull_request`, which never touches Bash
- Stop git-check, the D7 PostToolUse rules injector, the D10 telemetry log and
  the D6 session-context injector
- Hook shared libs (`io`, `config`, `segment-split`, `glob`) and a 53-case hook
  harness with fixtures, Linux and Windows-shaped payloads, and fail-open cases

section: Decided
- D24: cloud sessions install the plugin from an environment setup script;
  vendoring stays the documented fallback
- D25: U2 proceeds in parallel with the remaining Phase 0 owner rows
