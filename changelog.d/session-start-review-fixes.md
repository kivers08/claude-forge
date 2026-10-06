section: Security
- user-level-write: `>& file` (a file redirect, not a descriptor dup) into `~/.claude` is denied; redirect targets are read from the whole command because the segment splitter cuts at the `&`
- session start never reads a configured task file, handoff or hub that lies outside the project (`..`, absolute path, or a symlink leading out)
- user-level-write reads redirects inside `bash -c "..."` / `sh -c` arguments
- a merge into the base branch whose PR cannot be read is never silent: it is denied where no approval reaches the human, otherwise it asks, even with a fresh marker
section: Fixed
- a 5-second timeout on the git calls in the SessionStart version lookup
- the session context's very first line is `forge <version> (<commit>) loaded`, as documented
- hubs, formats.md, bootstrap and the framework block give the hub script command that works in an installed project (`node "${CLAUDE_PLUGIN_ROOT}/scripts/hub/hub.js"`)
- framework block: one order for the first reply (warnings, then the two-line status)
