#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
INSTALLER="$REPO_ROOT/integrations/claude-code/install.sh"
REAL_JQ="$(command -v jq)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
new_home() {
  local name="$1"
  export HOME="$TMP/$name"
  mkdir -p "$HOME/.claude"
}
run_installer() {
  bash "$INSTALLER" http://127.0.0.1:4747 test@example.invalid >/dev/null
}
sha() { sha256sum "$1" | cut -d' ' -f1; }

# Existing settings survive; PortCall hooks are added exactly once.
new_home existing
cat > "$HOME/.claude/settings.json" <<'JSON'
{
  "theme": "dark",
  "hooks": {
    "Stop": [{"hooks": [{"type": "command", "command": "keep-me"}]}]
  }
}
JSON
run_installer
"$REAL_JQ" -e '.theme == "dark"' "$HOME/.claude/settings.json" >/dev/null
"$REAL_JQ" -e '.hooks.Stop[0].hooks[0].command == "keep-me"' "$HOME/.claude/settings.json" >/dev/null
for event in SessionStart UserPromptSubmit SessionEnd; do
  count="$("$REAL_JQ" --arg event "$event" '[.hooks[$event][].hooks[] | select(.args[-1] == $event)] | length' "$HOME/.claude/settings.json")"
  [[ "$count" == 1 ]] || fail "$event hook count is $count"
done
first_settings="$(sha "$HOME/.claude/settings.json")"
first_hook="$(sha "$HOME/.claude/portcall/portcall-hook.sh")"
run_installer
[[ "$(sha "$HOME/.claude/settings.json")" == "$first_settings" ]] || fail 'settings changed on second install'
[[ "$(sha "$HOME/.claude/portcall/portcall-hook.sh")" == "$first_hook" ]] || fail 'hook changed on second install'

# Empty settings are treated as an empty object, not as a failed producer.
new_home empty
: > "$HOME/.claude/settings.json"
run_installer
"$REAL_JQ" -e '.hooks.SessionStart and .hooks.UserPromptSubmit and .hooks.SessionEnd' "$HOME/.claude/settings.json" >/dev/null

# Malformed settings fail closed and remain byte-identical.
new_home malformed
printf '{broken' > "$HOME/.claude/settings.json"
before="$(sha "$HOME/.claude/settings.json")"
if run_installer 2>/dev/null; then fail 'malformed settings were accepted'; fi
[[ "$(sha "$HOME/.claude/settings.json")" == "$before" ]] || fail 'malformed settings were rewritten'

# A jq failure during the merge must never truncate settings.json.
new_home jq_failure
printf '{"sentinel":"preserve"}\n' > "$HOME/.claude/settings.json"
before="$(sha "$HOME/.claude/settings.json")"
mkdir -p "$TMP/fake-bin"
cat > "$TMP/fake-bin/jq" <<EOF
#!/usr/bin/env bash
for arg in "\$@"; do
  [[ "\$arg" == hook ]] && exit 42
done
exec "$REAL_JQ" "\$@"
EOF
chmod +x "$TMP/fake-bin/jq"
if PATH="$TMP/fake-bin:$PATH" run_installer 2>/dev/null; then fail 'forced jq merge failure succeeded'; fi
[[ "$(sha "$HOME/.claude/settings.json")" == "$before" ]] || fail 'jq failure rewrote settings'

echo 'PASS: Claude Code bash installer is fail-closed and byte-stable'
