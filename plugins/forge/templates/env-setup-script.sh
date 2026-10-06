#!/bin/bash
# forge: cloud environment setup script (canonical copy). Paste it into the
# environment's "Setup script" box (cloud environment menu in the session
# title bar -> Edit).
#
# Purpose (opusjevos D-BL, D-BU): install forge AND bring it to the latest
# commit in every session, whatever repos are attached. Works without
# credentials because kivers08/claude-forge is public.
#
# Fails LOUDLY (non-zero exit, "FORGE-SETUP: FAILED ..." line). Its output is
# not visible to Claude in the session, so the check Claude CAN see is forge's
# own SessionStart line "forge <version> (<commit>) loaded" (hooks/lib/version.js),
# which also warns when the installed commit is behind the marketplace.
set -u

log() { echo "FORGE-SETUP: $*"; }

if ! command -v claude >/dev/null 2>&1; then
  log "FAILED: claude CLI not on PATH during setup"
  exit 2
fi

# Register the marketplace (a repeat on an already-registered one is harmless).
claude plugin marketplace add kivers08/claude-forge >/dev/null 2>&1 || true
claude plugin marketplace update claude-forge || { log "FAILED: marketplace update"; exit 3; }

# Installed forge commit vs the marketplace's latest commit. `plugin update`
# only compares VERSION NUMBERS (verified 2026-10-06: it kept 0.2.1 from before
# PR 25), so a commit mismatch means reinstall.
installed_sha() {
  node -e '
    const f = require("os").homedir() + "/.claude/plugins/installed_plugins.json";
    try {
      const e = (JSON.parse(require("fs").readFileSync(f, "utf8")).plugins["forge@claude-forge"] || [])[0] || {};
      process.stdout.write(String(e.gitCommitSha || ""));
    } catch (err) {}
  ' 2>/dev/null
}
latest=$(git -C "$HOME/.claude/plugins/marketplaces/claude-forge" rev-parse HEAD 2>/dev/null || true)

if claude plugin list 2>/dev/null | grep -q 'forge@claude-forge'; then
  if [ -n "$latest" ] && [ "$(installed_sha)" != "$latest" ]; then
    log "installed forge is not the latest commit; reinstalling"
    claude plugin uninstall forge@claude-forge >/dev/null 2>&1 || { log "FAILED: forge uninstall"; exit 4; }
    claude plugin install forge@claude-forge || { log "FAILED: forge reinstall"; exit 5; }
  fi
else
  claude plugin install forge@claude-forge || { log "FAILED: forge install"; exit 5; }
fi
[ -n "$latest" ] && [ "$(installed_sha)" != "$latest" ] && { log "FAILED: forge is still not at the latest commit"; exit 7; }

# Report what is installed (version + commit), for the start-of-session check.
info=$(node -e '
  const f = require("os").homedir() + "/.claude/plugins/installed_plugins.json";
  const e = (JSON.parse(require("fs").readFileSync(f, "utf8")).plugins["forge@claude-forge"] || [])[0] || {};
  process.stdout.write((e.version || "?") + " (" + String(e.gitCommitSha || "?").slice(0, 7) + ")");
' 2>/dev/null) || info="unknown"
claude plugin list 2>/dev/null | grep -q 'forge@claude-forge' \
  && log "forge ${info} installed" \
  || { log "FAILED: forge not listed after install"; exit 6; }
