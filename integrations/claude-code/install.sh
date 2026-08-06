#!/usr/bin/env bash
# PortCall -> Claude Code integration installer (Linux / WSL).
#
#   bash integrations/claude-code/install.sh [daemon-url] [owner-email]
#
# Installs the 'portcall' skill, the presence hooks, and a config file.
# Idempotent: re-running produces byte-identical output. Never rewrites an
# unparseable settings.json - it refuses instead. Requires jq.
set -euo pipefail

DAEMON_URL="${1:-http://127.0.0.1:4747}"
OWNER="${2:-$(git config user.email 2>/dev/null || true)}"
OWNER="${OWNER:-${USER:-someone}@local}"

command -v jq >/dev/null 2>&1 || { echo "jq is required (sudo apt-get install jq)" >&2; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_DIR="$HOME/.claude"
[ -d "$CLAUDE_DIR" ] || { echo "No $CLAUDE_DIR found - is Claude Code installed for this user?" >&2; exit 1; }

write_if_changed() { # path <- content on stdin
  local path="$1" tmp
  tmp="$(mktemp)"
  cat > "$tmp"
  if [ ! -f "$path" ] || ! cmp -s "$tmp" "$path"; then
    mv "$tmp" "$path"
  else
    rm -f "$tmp"
  fi
}

# --- 1. runtime dir --------------------------------------------------------
BASE="$CLAUDE_DIR/portcall"
mkdir -p "$BASE/state"
write_if_changed "$BASE/portcall-hook.sh" < "$HERE/portcall-hook.sh"
chmod +x "$BASE/portcall-hook.sh"
jq -n --arg d "${DAEMON_URL%/}" --arg o "$OWNER" '{daemonUrl: $d, owner: $o}' | write_if_changed "$BASE/config.json"

# --- 2. the skill ----------------------------------------------------------
mkdir -p "$CLAUDE_DIR/skills/portcall"
write_if_changed "$CLAUDE_DIR/skills/portcall/SKILL.md" < "$HERE/skill/SKILL.md"

# --- 3. hooks in settings.json ---------------------------------------------
# Buffer-and-confirm: build the merged JSON in a variable, verify jq succeeded
# AND the result re-parses, and only then touch the file. A failed producer
# must never reach the user's settings.json.
SETTINGS="$CLAUDE_DIR/settings.json"
HOOK="$BASE/portcall-hook.sh"
if [ -f "$SETTINGS" ]; then
  jq empty "$SETTINGS" 2>/dev/null || { echo "$SETTINGS is not valid JSON - fix it first; refusing to rewrite it." >&2; exit 1; }
  [ -f "$SETTINGS.portcall-backup" ] || cp "$SETTINGS" "$SETTINGS.portcall-backup"
  CURRENT="$(cat "$SETTINGS")"
  [ -n "$CURRENT" ] || CURRENT='{}'
else
  CURRENT='{}'
fi

MERGED="$(printf '%s' "$CURRENT" | jq --arg hook "$HOOK" '
  .hooks //= {} |
  .hooks.SessionStart     //= [] |
  .hooks.UserPromptSubmit //= [] |
  .hooks.SessionEnd       //= [] |
  reduce ([["SessionStart", 10], ["UserPromptSubmit", 10], ["SessionEnd", 5]][]) as [$evt, $t] (.;
    if ([.hooks[$evt][].hooks[]? | select(.args? and (.args | index($hook)))] | length) == 0 then
      .hooks[$evt] += [{hooks: [{type: "command", command: "bash",
        args: [$hook, $evt], timeout: $t, statusMessage: ("PortCall: " + $evt)}]}]
    else . end
  )')" || { echo "hook merge failed; $SETTINGS left untouched." >&2; exit 1; }
[ -n "$MERGED" ] && printf '%s' "$MERGED" | jq empty 2>/dev/null \
  || { echo "hook merge produced invalid JSON; $SETTINGS left untouched." >&2; exit 1; }
printf '%s\n' "$MERGED" | write_if_changed "$SETTINGS"

echo "PortCall Claude Code integration installed:"
echo "  skill  -> $CLAUDE_DIR/skills/portcall/SKILL.md"
echo "  hooks  -> $HOOK (SessionStart, UserPromptSubmit, SessionEnd)"
echo "  config -> $BASE/config.json (daemon $DAEMON_URL, owner $OWNER)"
echo "  NOTE: restart Claude Code (or open /hooks once) so running sessions pick up the hooks."
