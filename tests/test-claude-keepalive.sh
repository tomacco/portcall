#!/usr/bin/env bash
# The session keepalive: heartbeats between prompts, exits when the state
# file disappears or the daemon disowns the identity, and the hook never
# spawns a second loop for the same session.
set -euo pipefail

REPO_ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
KEEPALIVE="$REPO_ROOT/integrations/claude-code/portcall-keepalive.sh"
HOOK="$REPO_ROOT/integrations/claude-code/portcall-hook.sh"
STUB="$REPO_ROOT/tests/claude-hook-stub-daemon.mjs"
TMP="$(mktemp -d)"
STUB_PID=""

cleanup() {
  [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null || true
  pkill -f "portcall-keepalive.sh $TMP" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

start_stub() { # port hb-status
  node "$STUB" "$1" "$2" "$TMP/regs" >/dev/null 2>&1 &
  STUB_PID=$!
  for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$1/api/v1/names/suggest" >/dev/null 2>&1 && break; sleep 0.1; done
}
wait_gone() { # pattern -> succeeds when no process matches
  for _ in $(seq 1 20); do pgrep -f "$1" >/dev/null 2>&1 || return 0; sleep 0.3; done
  return 1
}

export HOME="$TMP"
mkdir -p "$TMP/.claude/portcall/state"

# 1. Healthy daemon: keepalive heartbeats repeatedly, then exits when the
#    state file disappears (SessionEnd contract).
PORT=4881
start_stub "$PORT" 200
STATE="$TMP/.claude/portcall/state/ka1.json"
printf '{"id":"ag_x","token":"tok_x","handle":"X","announced":true}' > "$STATE"
PORTCALL_URL="http://127.0.0.1:$PORT" bash "$KEEPALIVE" "$STATE" 0.3 &
sleep 1.5
HB="$(cat "$TMP/regs.hb" 2>/dev/null || echo 0)"
[ "$HB" -ge 2 ] || { echo "FAIL: expected >=2 heartbeats, saw $HB" >&2; exit 1; }
rm -f "$STATE"
wait_gone "portcall-keepalive.sh $STATE" || { echo 'FAIL: keepalive outlived its state file' >&2; exit 1; }

# 2. Disowned identity (401): keepalive exits by itself and does NOT register.
kill "$STUB_PID" 2>/dev/null || true; wait "$STUB_PID" 2>/dev/null || true
rm -f "$TMP/regs" "$TMP/regs.hb"
PORT=4882
start_stub "$PORT" 401
STATE="$TMP/.claude/portcall/state/ka2.json"
printf '{"id":"ag_x","token":"tok_x","handle":"X","announced":true}' > "$STATE"
PORTCALL_URL="http://127.0.0.1:$PORT" bash "$KEEPALIVE" "$STATE" 0.3 &
wait_gone "portcall-keepalive.sh $STATE" || { echo 'FAIL: keepalive survived a 401' >&2; exit 1; }
[ ! -f "$TMP/regs" ] || { echo 'FAIL: keepalive registered on its own' >&2; exit 1; }

# 3. The hook spawns exactly one keepalive per session, even across prompts.
kill "$STUB_PID" 2>/dev/null || true; wait "$STUB_PID" 2>/dev/null || true
rm -f "$TMP/regs" "$TMP/regs.hb"
PORT=4883
start_stub "$PORT" 200
mkdir -p "$TMP/.claude/portcall"
cp "$KEEPALIVE" "$TMP/.claude/portcall/portcall-keepalive.sh"
chmod +x "$TMP/.claude/portcall/portcall-keepalive.sh"
STATE="$TMP/.claude/portcall/state/hooked.json"
printf '{"id":"ag_x","token":"tok_x","handle":"X","announced":true}' > "$STATE"
export PORTCALL_KEEPALIVE_INTERVAL=0.3
printf '{"session_id":"hooked"}' | PORTCALL_URL="http://127.0.0.1:$PORT" bash "$HOOK" UserPromptSubmit >/dev/null
printf '{"session_id":"hooked"}' | PORTCALL_URL="http://127.0.0.1:$PORT" bash "$HOOK" UserPromptSubmit >/dev/null
sleep 0.5
COUNT="$(pgrep -fc "portcall-keepalive.sh $STATE" || echo 0)"
[ "$COUNT" = 1 ] || { echo "FAIL: expected exactly 1 keepalive, saw $COUNT" >&2; exit 1; }
rm -f "$STATE"
wait_gone "portcall-keepalive.sh $STATE" || { echo 'FAIL: hook-spawned keepalive leaked' >&2; exit 1; }

echo 'PASS: keepalive heartbeats between prompts, exits with its session, never duplicates'
