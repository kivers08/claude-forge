#!/bin/bash
# Unit tests for ../session-start.sh, using a fake `claude` on PATH so no
# real marketplace/plugin calls happen. Each fake run logs its args to
# $CALL_LOG and exits with $FAKE_CLAUDE_EXIT (space-separated, one per call,
# last value repeats for any extra calls).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$HERE/../session-start.sh"
FAKE_BIN_DIR="$(mktemp -d)"
CALL_LOG="$(mktemp)"
export CALL_LOG
trap 'rm -rf "$FAKE_BIN_DIR" "$CALL_LOG"' EXIT

cat > "$FAKE_BIN_DIR/claude" <<'EOF'
#!/bin/bash
echo "$*" >> "$CALL_LOG"
codes=($FAKE_CLAUDE_EXIT)
idx=$(( $(wc -l < "$CALL_LOG") - 1 ))
if [ "$idx" -ge "${#codes[@]}" ]; then idx=$((${#codes[@]} - 1)); fi
exit "${codes[$idx]:-0}"
EOF
chmod +x "$FAKE_BIN_DIR/claude"

fail=0

run_case() {
  local name="$1" remote="$2" exits="$3" expect_exit="$4" expect_calls="$5"
  : > "$CALL_LOG"
  local actual_exit=0
  PATH="$FAKE_BIN_DIR:$PATH" CLAUDE_CODE_REMOTE="$remote" FAKE_CLAUDE_EXIT="$exits" "$HOOK" >/tmp/session-start-test.out 2>&1 || actual_exit=$?
  local actual_calls
  actual_calls=$(wc -l < "$CALL_LOG" | tr -d ' ')
  if [ "$actual_exit" != "$expect_exit" ] || [ "$actual_calls" != "$expect_calls" ]; then
    echo "FAIL: $name (exit=$actual_exit want=$expect_exit, calls=$actual_calls want=$expect_calls)"
    cat /tmp/session-start-test.out
    fail=1
  else
    echo "PASS: $name"
  fi
}

# Not remote: no-op, no claude calls at all.
run_case "non-remote is a no-op" "" "0" 0 0

# Remote, everything succeeds: marketplace add + both plugin installs.
run_case "remote success calls all three" "true" "0" 0 3

# Remote, marketplace add fails: aborts before either install.
run_case "marketplace failure aborts before installs" "true" "1" 1 1

# Remote, marketplace add ok, forge install fails: smoke install still runs, exit 1.
run_case "one plugin install failing doesn't block the other" "true" "0 1 0" 1 3

exit "$fail"
