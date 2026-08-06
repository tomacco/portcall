#!/usr/bin/env bash
# The autostart hook: brings the daemon up when the harbor is dark, no-ops
# when it already answers, and never breaks a session.
set -euo pipefail

REPO_ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
ENSURE_SRC="$REPO_ROOT/integrations/claude-code/portcall-ensure-daemon.sh"
PORT=4879
URL="http://127.0.0.1:$PORT"
TMP="$(mktemp -d)"

cleanup() {
  local pid
  pid="$(lsof -t -i ":$PORT" 2>/dev/null | head -1 || true)"
  [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

export HOME="$TMP/home"
mkdir -p "$HOME/.claude/portcall"
cp "$ENSURE_SRC" "$HOME/.claude/portcall/portcall-ensure-daemon.sh"
chmod +x "$HOME/.claude/portcall/portcall-ensure-daemon.sh"
jq -n --arg d "$URL" --arg r "$REPO_ROOT" '{daemonUrl: $d, owner: "test@example.invalid", repo: $r}' \
  > "$HOME/.claude/portcall/config.json"

# Dark harbor -> the hook starts the daemon and waits until it answers.
bash "$HOME/.claude/portcall/portcall-ensure-daemon.sh"
curl -sf "$URL/api/v1/status" >/dev/null || { echo 'FAIL: daemon not up after ensure' >&2; exit 1; }
UPTIME1="$(curl -sf "$URL/api/v1/status" | jq .uptimeSec)"

# Lit harbor -> no-op: same daemon keeps running (uptime does not reset).
sleep 1.2
bash "$HOME/.claude/portcall/portcall-ensure-daemon.sh"
UPTIME2="$(curl -sf "$URL/api/v1/status" | jq .uptimeSec)"
[ "$UPTIME2" -ge "$UPTIME1" ] || { echo 'FAIL: ensure restarted a healthy daemon' >&2; exit 1; }

# Missing repo config -> quiet no-op, exit 0, nothing launched.
PORT2=4880
jq -n --arg d "http://127.0.0.1:$PORT2" '{daemonUrl: $d, owner: "x@y"}' \
  > "$HOME/.claude/portcall/config.json"
bash "$HOME/.claude/portcall/portcall-ensure-daemon.sh"
if curl -sf "http://127.0.0.1:$PORT2/api/v1/status" >/dev/null 2>&1; then
  echo 'FAIL: ensure launched a daemon with no repo configured' >&2; exit 1
fi

echo 'PASS: autostart raises a dark harbor, leaves a lit one alone, fails quiet without a repo'
