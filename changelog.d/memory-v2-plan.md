section: Docs
- `docs/plans/forge-adoption.md`: an operator's manual for adopting and running
  the plugin — bootstrap, the daily loop, tiers, the revised merge policy, the
  advisory-vs-mechanics split in `reviewer clean`, and the current known gaps
  (D27, the D20 branch-protection blocker, the D19 follow-up, the reviewer
  agent-memory gap).
- `docs/plans/memory-v2.md`: a D28 proposal for a native, Node-based memory
  subsystem that takes PMB's good ideas (typed records, hybrid recall, dedup,
  session restore, earned-lesson measurement, redaction) while rejecting the
  parts that conflict with forge's decisions (no per-agent scope, auto-recall as
  invisible policy, a write-capable MCP in the review path, binary user-level
  storage, a Python + 450 MB prerequisite). Plan only — no implementation.
