#!/bin/bash
set -uo pipefail

# Fresh Claude Code cloud containers register this repo's marketplace via
# .claude/settings.json's extraKnownMarketplaces/enabledPlugins, but that
# registration alone does not install the plugins (see docs/decisions.md D24,
# docs/phase0-results.md check 6). Run the install explicitly, synchronously,
# before the session's tool loop starts, so forge's and smoke's own hooks are
# active from this session's first turn.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

claude plugin marketplace add kivers08/claude-forge || {
  echo "forge session-start: marketplace add failed, plugins will not be available this session" >&2
  exit 1
}

status=0
claude plugin install forge@claude-forge || { echo "forge session-start: forge install failed" >&2; status=1; }
claude plugin install smoke@claude-forge || { echo "forge session-start: smoke install failed" >&2; status=1; }
exit "$status"
