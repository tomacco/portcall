#!/usr/bin/env bash
# PortCall keepalive: heartbeat one session's agent on a timer so it stays
# "online" between user prompts. Spawned detached by portcall-hook.sh.
#
# Reads credentials from the session state file at runtime and never prints
# them. Exit rules:
#   - state file gone (SessionEnd cleaned up)      -> exit, do not linger
#   - daemon says 401/404 (identity disowned)      -> exit; the next prompt's
#     hook re-registers and respawns us with the fresh identity
#   - daemon busy/unreachable                      -> keep waiting quietly
# This loop NEVER registers: identity is minted only by the hook, so a slow
# daemon can't make two processes race to re-register the same session.
#
#   portcall-keepalive.sh <state-file> [interval-seconds]
set -u

STATE="${1:-}"
INTERVAL="${2:-${PORTCALL_KEEPALIVE_INTERVAL:-20}}"
[ -n "$STATE" ] || exit 0

BASE="$HOME/.claude/portcall"
CFG="$BASE/config.json"
DAEMON="${PORTCALL_URL:-$(jq -r '.daemonUrl // empty' "$CFG" 2>/dev/null)}"
DAEMON="${DAEMON:-http://127.0.0.1:4747}"
DAEMON="${DAEMON%/}"

command -v jq >/dev/null 2>&1 || exit 0
command -v curl >/dev/null 2>&1 || exit 0

while true; do
  [ -f "$STATE" ] || exit 0
  ID="$(jq -r '.id // empty' "$STATE" 2>/dev/null)"
  TOKEN="$(jq -r '.token // empty' "$STATE" 2>/dev/null)"
  if [ -n "$ID" ] && [ -n "$TOKEN" ]; then
    HB="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 -X POST \
      -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
      "$DAEMON/api/v1/agents/$ID/heartbeat" 2>/dev/null || true)"
    case "$HB" in
      401|404) exit 0 ;;  # disowned: the hook owns re-registration
    esac
  fi
  sleep "$INTERVAL"
done
