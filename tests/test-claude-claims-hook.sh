#!/usr/bin/env bash
# The hook must surface OTHER agents' claims overlapping the session cwd,
# and stay silent about the session's own claims.
set -euo pipefail

REPO_ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
PORT=4884
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
for _ in $(seq 1 40); do curl -sf "$DAEMON/api/v1/status" >/dev/null && break; sleep .05; done

export HOME="$TMP/home"
mkdir -p "$HOME/.claude/portcall/state"
cp integrations/claude-code/portcall-hook.sh "$HOME/.claude/portcall/portcall-hook.sh"
chmod +x "$HOME/.claude/portcall/portcall-hook.sh"
jq -n --arg daemon "$DAEMON" '{daemonUrl:$daemon, owner:"test@example.invalid"}' > "$HOME/.claude/portcall/config.json"
HOOK="$HOME/.claude/portcall/portcall-hook.sh"
INPUT='{"session_id":"claims-test","cwd":"/tmp/project/sub"}'

printf '%s' "$INPUT" | "$HOOK" SessionStart >/dev/null
STATE="$HOME/.claude/portcall/state/claims-test.json"
MY_ID="$(jq -r .id "$STATE")"
MY_TOKEN="$(jq -r .token "$STATE")"

# A peer claims the parent tree of this session's cwd.
PEER="$(curl -sf -H 'content-type: application/json' -d '{"handle":"Rival","whoami":{"harness":"test","owner":"t","purpose":"claims"}}' "$DAEMON/api/v1/agents")"
PEER_ID="$(printf '%s' "$PEER" | jq -r .id)"
PEER_TOKEN="$(printf '%s' "$PEER" | jq -r .token)"
curl -sf -H 'content-type: application/json' -H "authorization: Bearer $PEER_TOKEN" \
  -d "{\"from\":\"$PEER_ID\",\"path\":\"/tmp/project\",\"note\":\"refactoring the widgets\",\"ttlSec\":600}" \
  "$DAEMON/api/v1/claims" >/dev/null
# This session also claims something overlapping its own cwd - must NOT be injected.
curl -sf -H 'content-type: application/json' -H "authorization: Bearer $MY_TOKEN" \
  -d "{\"from\":\"$MY_ID\",\"path\":\"/tmp/project/sub\",\"note\":\"my own work\",\"ttlSec\":600}" \
  "$DAEMON/api/v1/claims" >/dev/null

OUT="$(printf '%s' "$INPUT" | "$HOOK" UserPromptSubmit)"
CTX="$(printf '%s' "$OUT" | jq -r '.hookSpecificOutput.additionalContext')"
printf '%s' "$CTX" | grep -Fq 'refactoring the widgets' || { echo 'FAIL: peer claim not injected' >&2; exit 1; }
printf '%s' "$CTX" | grep -Fq 'Rival' || { echo 'FAIL: claim holder not named' >&2; exit 1; }
printf '%s' "$CTX" | grep -Fq 'my own work' && { echo 'FAIL: own claim injected back' >&2; exit 1; }

# Non-overlapping cwd -> no claims section.
OUT2="$(printf '{"session_id":"claims-test","cwd":"/somewhere/else"}' | "$HOOK" UserPromptSubmit)"
if [ -n "$OUT2" ]; then
  printf '%s' "$OUT2" | jq -r '.hookSpecificOutput.additionalContext // ""' | grep -Fq 'PortCall claims' \
    && { echo 'FAIL: irrelevant claim injected' >&2; exit 1; }
fi

export HOME="$ORIGINAL_HOME"
echo 'PASS: hook surfaces overlapping peer claims and stays quiet otherwise'
