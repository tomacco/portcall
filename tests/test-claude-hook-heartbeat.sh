#!/usr/bin/env bash
# The hook's re-register policy: identity must survive a busy/unreachable
# daemon and only be re-minted when the daemon explicitly disowns it (401/404).
# Uses a scripted stub daemon so non-200 heartbeat statuses can be forced.
set -euo pipefail

REPO_ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
HOOK_SRC="$REPO_ROOT/integrations/claude-code/portcall-hook.sh"
STUB="$REPO_ROOT/tests/claude-hook-stub-daemon.mjs"

run_case() { # heartbeat-status expect-reregister(yes/no)
  local status="$1" expect="$2"
  local h port regfile stubpid id
  h="$(mktemp -d)"; mkdir -p "$h/.claude/portcall/state"
  port=$(( (RANDOM % 20000) + 20000 ))
  regfile="$h/regs"
  node "$STUB" "$port" "$status" "$regfile" >/dev/null 2>&1 &
  stubpid=$!
  for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$port/api/v1/names/suggest" >/dev/null 2>&1 && break; sleep 0.1; done

  printf '{"id":"ag_original","token":"tok_original","handle":"Original","announced":true}' \
    > "$h/.claude/portcall/state/sess1.json"

  printf '{"session_id":"sess1"}' | HOME="$h" PORTCALL_URL="http://127.0.0.1:$port" bash "$HOOK_SRC" UserPromptSubmit >/dev/null

  id="$(jq -r .id "$h/.claude/portcall/state/sess1.json")"
  if [ "$expect" = "yes" ]; then
    [ "$id" != "ag_original" ] || { echo "FAIL: hb=$status should have re-registered" >&2; exit 1; }
    [ -f "$regfile" ] || { echo "FAIL: hb=$status made no registration call" >&2; exit 1; }
  else
    [ "$id" = "ag_original" ] || { echo "FAIL: hb=$status churned the identity" >&2; exit 1; }
    [ ! -f "$regfile" ] || { echo "FAIL: hb=$status re-registered spuriously" >&2; exit 1; }
  fi
  kill "$stubpid" 2>/dev/null || true
  rm -rf "$h"
}

run_case 200 no   # healthy: keep identity
run_case 401 yes  # daemon disowns us (restart/eviction): re-register
run_case 404 yes
run_case 503 no   # busy daemon: keep identity, stay quiet

# unreachable daemon: keep identity, still exit 0
h="$(mktemp -d)"; mkdir -p "$h/.claude/portcall/state"
printf '{"id":"ag_original","token":"tok_original","handle":"Original","announced":true}' \
  > "$h/.claude/portcall/state/sess1.json"
printf '{"session_id":"sess1"}' | HOME="$h" PORTCALL_URL="http://127.0.0.1:1" bash "$HOOK_SRC" UserPromptSubmit >/dev/null
[ "$(jq -r .id "$h/.claude/portcall/state/sess1.json")" = "ag_original" ] \
  || { echo "FAIL: unreachable daemon churned the identity" >&2; exit 1; }
rm -rf "$h"

echo 'PASS: hook identity survives busy/unreachable daemons and re-registers only on 401/404'
