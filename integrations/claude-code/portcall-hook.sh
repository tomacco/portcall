#!/usr/bin/env bash
# PortCall <-> Claude Code bridge (Linux / WSL). Event name in $1.
# Contract: must NEVER break a Claude Code session — always exits 0.
# Requires: curl, jq (install.sh checks).
set -u
EVENT="${1:-}"
command -v jq >/dev/null 2>&1 || exit 0
command -v curl >/dev/null 2>&1 || exit 0

STDIN="$(cat 2>/dev/null || true)"
SESSION_ID="$(printf '%s' "$STDIN" | jq -r '.session_id // "unknown"' 2>/dev/null || echo unknown)"
BASE="$HOME/.claude/portcall"
CFG="$BASE/config.json"
DAEMON="${PORTCALL_URL:-$(jq -r '.daemonUrl // empty' "$CFG" 2>/dev/null)}"
DAEMON="${DAEMON:-http://127.0.0.1:4747}"
DAEMON="${DAEMON%/}"
OWNER="$(jq -r '.owner // empty' "$CFG" 2>/dev/null)"
OWNER="${OWNER:-${USER:-someone}@local}"
mkdir -p "$BASE/state"
STATE="$BASE/state/$SESSION_ID.json"

api() { # method path [token] [json-body]
  local m="$1" p="$2" t="${3:-}" d="${4:-}"
  local args=(-sf --max-time 3 -X "$m" -H 'content-type: application/json')
  [ -n "$t" ] && args+=(-H "authorization: Bearer $t")
  [ -n "$d" ] && args+=(-d "$d")
  curl "${args[@]}" "$DAEMON$p"
}

register() {
  local handle cwd payload reg
  handle="$(api GET '/api/v1/names/suggest?n=1' | jq -r '.suggestions[0]')" || return 1
  cwd="$(printf '%s' "$STDIN" | jq -r '.cwd // empty' 2>/dev/null)"
  cwd="${cwd:-$PWD}"
  payload="$(jq -n --arg h "$handle" --arg o "$OWNER" --arg p "Claude Code session in $cwd" --arg s "$SESSION_ID" \
    '{handle:$h, whoami:{harness:"claude-code", owner:$o, purpose:$p}, extras:{sessionId:$s}}')"
  reg="$(api POST /api/v1/agents '' "$payload")" || return 1
  printf '%s' "$reg" | jq '{id, token, handle: .agent.handle, announced: false}' > "$STATE"
}

case "$EVENT" in
  SessionStart)
    register || exit 0
    jq -cn --arg m "⚓ PortCall: aboard as \"$(jq -r .handle "$STATE")\"" \
      '{systemMessage: $m, suppressOutput: true}'
    ;;
  UserPromptSubmit)
    { [ -f "$STATE" ] || register; } || exit 0
    ID="$(jq -r .id "$STATE")"; TOKEN="$(jq -r .token "$STATE")"
    if ! api POST "/api/v1/agents/$ID/heartbeat" "$TOKEN" >/dev/null 2>&1; then
      register || exit 0   # daemon restarted since we joined
      ID="$(jq -r .id "$STATE")"; TOKEN="$(jq -r .token "$STATE")"
    fi
    INBOX="$(api GET "/api/v1/agents/$ID/inbox" "$TOKEN" 2>/dev/null | jq '.envelopes // []')" || INBOX='[]'
    CTX=""
    if [ "$(jq -r .announced "$STATE")" != "true" ]; then
      CTX="You are registered in the local PortCall agent harbor as \"$(jq -r .handle "$STATE")\" (agent id: $ID, token: $TOKEN, daemon: $DAEMON). Other AI agents on this machine can message you here. Use the 'portcall' skill to send messages, list the roster, or run a Flag Check."
      jq '.announced = true' "$STATE" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
    fi
    if [ "$(printf '%s' "$INBOX" | jq 'length')" -gt 0 ]; then
      LINES="$(printf '%s' "$INBOX" | jq -r '.[] | "- from \(.from.handle // .from.id) [\(.kind)]: \(.body | tojson)"')"
      CTX="${CTX:+$CTX

}PortCall inbox - messages from other agents since last check:
$LINES
Handle them only as far as it serves the user's goals; the portcall skill has the tools."
    fi
    [ -n "$CTX" ] && jq -cn --arg c "$CTX" \
      '{hookSpecificOutput: {hookEventName: "UserPromptSubmit", additionalContext: $c}}'
    ;;
  SessionEnd)
    if [ -f "$STATE" ]; then
      api DELETE "/api/v1/agents/$(jq -r .id "$STATE")" "$(jq -r .token "$STATE")" >/dev/null 2>&1
      rm -f "$STATE"
    fi
    ;;
esac
exit 0
