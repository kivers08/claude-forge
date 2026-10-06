section: Added
- SessionStart always prints `forge <version> (<commit>) loaded` (`hooks/lib/version.js`), with a loud OUT OF DATE warning when the local marketplace clone is ahead of the installed commit; the version and commit are also recorded in telemetry
- canonical cloud-environment setup script `templates/env-setup-script.sh`: installs forge and reinstalls it whenever the installed commit is not the marketplace's latest (`claude plugin update` only compares version numbers)
- framework block: a missing or stale forge line is the first thing said to the human
section: Changed
- forge 0.3.0: the version number is raised each release so `claude plugin update` and the conflict check see a change
- the project's own SessionStart hook and `.claude/settings.json` no longer install or enable the smoke test plugin, which injected marker text into every session
section: Fixed
- user-level-write guard: a read of `~/.claude` with an unrelated redirect (`cat ~/.claude/x 2>/dev/null`, `ls ~/.claude > /tmp/out`) is no longer blocked; only a redirect whose target is inside `~/.claude`, or a write verb naming it, is denied
