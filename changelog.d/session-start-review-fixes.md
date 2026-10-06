section: Security
- user-level-write: `>& file` (a file redirect, not a descriptor dup) into `~/.claude` is denied; redirect targets are read from the whole command because the segment splitter cuts at the `&`
- session start never reads a configured task file, handoff or hub that lies outside the project (`..`, absolute path, or a symlink leading out)
section: Fixed
- the session context's very first line is `forge <version> (<commit>) loaded`, as documented
- hubs, formats.md, bootstrap and the framework block give the hub script command that works in an installed project (`node "${CLAUDE_PLUGIN_ROOT}/scripts/hub/hub.js"`)
- framework block: one order for the first reply (warnings, then the two-line status)
