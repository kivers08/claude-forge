section: Added
- D23 telemetry metrics: a new `SubagentStop` hook
  (`plugins/forge/hooks/subagent-telemetry.js`) appends a `unit_complete`
  event to the existing `telemetry.jsonl` (D10) alongside the pre-existing
  `invocation` events. Records `output_chars` (an honest proxy for output
  volume — the actual `SubagentStop` payload carries no token/usage field
  on this Claude Code version, verified against the smoke plugin's recorded
  fixture, so none is fabricated) and, for `forge:reviewer` dispatches only,
  the four finding counts (bugs/security/convention/suggestions) parsed
  from the reviewer's own closing summary line. Falls back to `null` rather
  than guessing when the summary line isn't present or doesn't match.
- `plugins/forge/hooks/tests/run.js`: added a `fileIncludes` expectation
  (substring check against a file's contents) to the shared hook-test
  harness, needed to assert the new hook's parsed output actually lands in
  `telemetry.jsonl` correctly.
