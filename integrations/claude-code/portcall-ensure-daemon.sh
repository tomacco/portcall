#!/usr/bin/env bash
# Ensure the local PortCall daemon is running. Wired into Claude Code
# SessionStart by install.sh (before the registration hook, so the harbor is
# up by the time the session tries to board).
#
# Contract: NEVER break a session — always exit 0. Idempotent: no-op if the
# harbor already answers. Upstreamed from the keepalive scripts the first
# harbor crews hand-rolled in ~/.claude/portcall.
set -u

BASE="$HOME/.claude/portcall"
CFG="$BASE/config.json"
LOG="$BASE/daemon.log"

URL="${PORTCALL_URL:-}"
if [ -z "$URL" ] && command -v jq >/dev/null 2>&1; then
  URL="$(jq -r '.daemonUrl // empty' "$CFG" 2>/dev/null)"
fi
URL="${URL:-http://127.0.0.1:4747}"
URL="${URL%/}"

# The daemon repo: env override -> config.json (written by install.sh).
REPO="${PORTCALL_REPO:-}"
if [ -z "$REPO" ] && command -v jq >/dev/null 2>&1; then
  REPO="$(jq -r '.repo // empty' "$CFG" 2>/dev/null)"
fi

reachable() {
  command -v curl >/dev/null 2>&1 && \
    curl -sf --max-time 2 "$URL/api/v1/status" -o /dev/null 2>&1
}

# Already sailing? Nothing to do.
reachable && exit 0

# Need node and the repo to launch it.
command -v node >/dev/null 2>&1 || exit 0
[ -n "$REPO" ] && [ -f "$REPO/src/daemon.ts" ] || exit 0

# Serve on the port the config points at, not whatever the daemon defaults to.
PORT="${URL##*:}"
case "$PORT" in *[!0-9]*|'') PORT=4747 ;; esac

# Launch fully detached so it outlives this hook AND the Claude Code session,
# then wait (capped) until it answers so the registration hook that follows
# finds the harbor open.
# setsid is Linux-only; macOS has none, and the subshell + nohup still detach the daemon.
SETSID="$(command -v setsid || true)"
( cd "$REPO" && PORTCALL_PORT="$PORT" $SETSID nohup node src/daemon.ts >>"$LOG" 2>&1 </dev/null & ) >/dev/null 2>&1
# --max-time is per-attempt; --retry-max-time caps the whole wait so the
# script honors its own budget even against a blackholed non-local URL.
command -v curl >/dev/null 2>&1 && \
  curl -sf --retry 10 --retry-delay 1 --retry-connrefused --max-time 12 \
    --retry-max-time 12 "$URL/api/v1/status" -o /dev/null 2>&1

exit 0
