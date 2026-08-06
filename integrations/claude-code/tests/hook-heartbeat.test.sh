#!/usr/bin/env bash
# Regression tests for the hook's re-register policy: identity must survive
# a busy/unreachable daemon and only be re-minted on an explicit 401/404.
#
#   bash integrations/claude-code/tests/hook-heartbeat.test.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
HOOK="$HERE/../portcall-hook.sh"
PASS=0; FAIL=0
check() { if [ "$2" -eq 0 ]; then PASS=$((PASS+1)); echo "  ok: $1"; else FAIL=$((FAIL+1)); echo "  FAIL: $1"; fi; }

run_case() { # name heartbeat-status expect-reregister(yes/no)
  local name="$1" status="$2" expect="$3"
  local h port regfile out stubpid
  h="$(mktemp -d)"; mkdir -p "$h/.claude/portcall/state"
  port=$(( (RANDOM % 20000) + 20000 ))
  regfile="$h/regs"
  node "$HERE/stub-daemon.mjs" "$port" "$status" "$regfile" >/dev/null 2>&1 &
  stubpid=$!
  for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$port/api/v1/names/suggest" >/dev/null 2>&1 && break; sleep 0.1; done

  printf '{"id":"ag_original","token":"tok_original","handle":"Original","announced":true}' \
    > "$h/.claude/portcall/state/sess1.json"

  out="$(printf '{"session_id":"sess1"}' | HOME="$h" PORTCALL_URL="http://127.0.0.1:$port" bash "$HOOK" UserPromptSubmit)"
  local rc=$?
  check "$name: hook exits 0" $rc

  local id; id="$(jq -r .id "$h/.claude/portcall/state/sess1.json")"
  if [ "$expect" = "yes" ]; then
    [ "$id" != "ag_original" ]; check "$name: re-registered (id changed)" $?
    [ -f "$regfile" ]; check "$name: registration call made" $?
  else
    [ "$id" = "ag_original" ]; check "$name: identity preserved" $?
    [ ! -f "$regfile" ]; check "$name: no registration call" $?
  fi
  kill "$stubpid" 2>/dev/null || true
  rm -rf "$h"
}

echo "healthy daemon (200): keep identity"
run_case "hb-200" 200 no

echo "identity disowned (401): re-register"
run_case "hb-401" 401 yes

echo "busy daemon (503): keep identity, stay quiet"
run_case "hb-503" 503 no

echo "unreachable daemon: keep identity, stay quiet"
h="$(mktemp -d)"; mkdir -p "$h/.claude/portcall/state"
printf '{"id":"ag_original","token":"tok_original","handle":"Original","announced":true}' \
  > "$h/.claude/portcall/state/sess1.json"
printf '{"session_id":"sess1"}' | HOME="$h" PORTCALL_URL="http://127.0.0.1:1" bash "$HOOK" UserPromptSubmit >/dev/null
check "down: hook exits 0" $?
[ "$(jq -r .id "$h/.claude/portcall/state/sess1.json")" = "ag_original" ]
check "down: identity preserved" $?
rm -rf "$h"

echo
echo "passed $PASS, failed $FAIL"
[ "$FAIL" -eq 0 ]
