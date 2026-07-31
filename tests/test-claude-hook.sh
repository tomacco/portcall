#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
PORT=4878
DAEMON="http://127.0.0.1:$PORT"
TMP="$(mktemp -d)"
ORIGINAL_HOME="$HOME"

cd "$REPO_ROOT"
node src/daemon.ts --port "$PORT" --identity none > "$TMP/daemon.log" 2>&1 &
DAEMON_PID=$!
cleanup() {
  kill "$DAEMON_PID" 2>/dev/null || true
  wait "$DAEMON_PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT
for _ in $(seq 1 40); do
  curl -sf "$DAEMON/api/v1/status" >/dev/null && break
  sleep .05
done
curl -sf "$DAEMON/api/v1/status" >/dev/null

export HOME="$TMP/home"
mkdir -p "$HOME/.claude/portcall/state"
cp integrations/claude-code/portcall-hook.sh "$HOME/.claude/portcall/portcall-hook.sh"
chmod +x "$HOME/.claude/portcall/portcall-hook.sh"
jq -n --arg daemon "$DAEMON" '{daemonUrl:$daemon, owner:"test@example.invalid"}' > "$HOME/.claude/portcall/config.json"
HOOK="$HOME/.claude/portcall/portcall-hook.sh"
INPUT='{"session_id":"hook-test","cwd":"/tmp/project"}'

START="$(printf '%s' "$INPUT" | "$HOOK" SessionStart)"
printf '%s' "$START" | jq -e '.systemMessage | contains("aboard as")' >/dev/null
STATE="$HOME/.claude/portcall/state/hook-test.json"
ID="$(jq -r .id "$STATE")"
TOKEN="$(jq -r .token "$STATE")"

PEER="$(curl -sf -H 'content-type: application/json' -d '{"handle":"Peer","whoami":{"harness":"test","owner":"test","purpose":"hook inbox"}}' "$DAEMON/api/v1/agents")"
PEER_ID="$(printf '%s' "$PEER" | jq -r .id)"
PEER_TOKEN="$(printf '%s' "$PEER" | jq -r .token)"
CHANNEL="$(curl -sf -H 'content-type: application/json' -H "authorization: Bearer $PEER_TOKEN" \
  -d "{\"from\":\"$PEER_ID\",\"topic\":\"Hook safety\",\"visibility\":\"public\"}" "$DAEMON/api/v1/channels")"
CHANNEL_ID="$(printf '%s' "$CHANNEL" | jq -r .id)"
curl -sf -H 'content-type: application/json' -H "authorization: Bearer $TOKEN" \
  -d "{\"from\":\"$ID\"}" "$DAEMON/api/v1/channels/$CHANNEL_ID/join" >/dev/null
curl -sf -H 'content-type: application/json' -H "authorization: Bearer $PEER_TOKEN" \
  -d "{\"from\":\"$PEER_ID\",\"kind\":\"chat\",\"body\":{\"text\":\"fixture signal\"}}" \
  "$DAEMON/api/v1/channels/$CHANNEL_ID/messages" >/dev/null

PROMPT="$(printf '%s' "$INPUT" | "$HOOK" UserPromptSubmit)"
printf '%s' "$PROMPT" | jq -e --arg channel "$CHANNEL_ID" \
  '.hookSpecificOutput.additionalContext | contains("UNTRUSTED") and contains($channel) and contains("fixture signal")' >/dev/null
if printf '%s' "$PROMPT" | grep -Fq "$TOKEN"; then
  echo 'FAIL: hook token leaked into model context' >&2
  exit 1
fi

printf '%s' "$INPUT" | "$HOOK" SessionEnd >/dev/null
test ! -f "$STATE"
curl -sf "$DAEMON/api/v1/agents" | jq -e --arg id "$ID" '[.agents[].id] | index($id) == null' >/dev/null
export HOME="$ORIGINAL_HOME"
echo 'PASS: Claude hook lifecycle is channel-bound and keeps credentials out of context'
