#!/usr/bin/env bash
# Regression tests for integrations/claude-code/install.sh.
# Runs everything against a disposable $HOME fixture — never touches the real one.
#
#   bash integrations/claude-code/tests/install-sh.test.sh
#
# Covers the settings.json safety contract:
#   1. fresh install produces valid JSON with all three hooks wired
#   2. existing env/permissions/hooks are preserved
#   3. re-running is byte-stable (idempotent)
#   4. unparseable settings.json -> refuse, file untouched
#   5. a failing merge producer (jq dies mid-merge) -> settings.json untouched
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
INSTALL="$HERE/../install.sh"
PASS=0; FAIL=0

check() { # name condition-exit-code
  if [ "$2" -eq 0 ]; then PASS=$((PASS+1)); echo "  ok: $1"
  else FAIL=$((FAIL+1)); echo "  FAIL: $1"; fi
}

fixture() { # fresh fake HOME with a .claude dir; echoes the path
  local h; h="$(mktemp -d)"
  mkdir -p "$h/.claude"
  echo "$h"
}

SETTINGS_WITH_CONTENT='{
  "env": {"MY_VAR": "keep-me"},
  "permissions": {"allow": ["Bash(ls:*)"]},
  "hooks": {"SessionStart": [{"hooks": [{"type": "command", "command": "echo", "args": ["pre-existing"]}]}]}
}'

echo "1. fresh install: valid JSON, hooks wired"
H="$(fixture)"
HOME="$H" bash "$INSTALL" http://127.0.0.1:9999 test@example.com >/dev/null
jq empty "$H/.claude/settings.json"; check "settings.json is valid JSON" $?
for evt in SessionStart UserPromptSubmit SessionEnd; do
  jq -e --arg e "$evt" '.hooks[$e][] | .hooks[] | select(.command == "bash")' \
    "$H/.claude/settings.json" >/dev/null; check "$evt hook wired" $?
done
jq -e '.hooks[][] | .hooks[] | select(.type == "command" and (.args | type == "array"))' \
  "$H/.claude/settings.json" >/dev/null; check "hook entries match Claude Code schema" $?
rm -rf "$H"

echo "2. existing settings preserved"
H="$(fixture)"
printf '%s' "$SETTINGS_WITH_CONTENT" > "$H/.claude/settings.json"
HOME="$H" bash "$INSTALL" http://127.0.0.1:9999 test@example.com >/dev/null
jq -e '.env.MY_VAR == "keep-me"' "$H/.claude/settings.json" >/dev/null; check "env preserved" $?
jq -e '.permissions.allow == ["Bash(ls:*)"]' "$H/.claude/settings.json" >/dev/null; check "permissions preserved" $?
jq -e '.hooks.SessionStart[] | .hooks[] | select(.args == ["pre-existing"])' \
  "$H/.claude/settings.json" >/dev/null; check "pre-existing hook preserved" $?
test -f "$H/.claude/settings.json.portcall-backup"; check "backup taken" $?

echo "3. idempotent: second run is byte-stable"
BEFORE="$(sha256sum "$H/.claude/settings.json" | cut -d' ' -f1)"
HOME="$H" bash "$INSTALL" http://127.0.0.1:9999 test@example.com >/dev/null
AFTER="$(sha256sum "$H/.claude/settings.json" | cut -d' ' -f1)"
[ "$BEFORE" = "$AFTER" ]; check "settings.json byte-stable across re-run" $?
rm -rf "$H"

echo "4. unparseable settings.json: refuse, leave untouched"
H="$(fixture)"
printf 'this is { not json' > "$H/.claude/settings.json"
set +e
HOME="$H" bash "$INSTALL" http://127.0.0.1:9999 test@example.com >/dev/null 2>&1
RC=$?
set -e
[ "$RC" -ne 0 ]; check "installer exits nonzero" $?
[ "$(cat "$H/.claude/settings.json")" = 'this is { not json' ]; check "broken file untouched" $?
rm -rf "$H"

echo "5. failing merge producer must not touch settings.json"
H="$(fixture)"
printf '%s' "$SETTINGS_WITH_CONTENT" > "$H/.claude/settings.json"
BEFORE="$(sha256sum "$H/.claude/settings.json" | cut -d' ' -f1)"
# jq shim: behave normally, except die on the merge call (recognized by --arg hook).
SHIM="$(mktemp -d)"
REAL_JQ="$(command -v jq)"
cat > "$SHIM/jq" <<EOF
#!/usr/bin/env bash
for a in "\$@"; do [ "\$a" = "hook" ] && exit 5; done
exec "$REAL_JQ" "\$@"
EOF
chmod +x "$SHIM/jq"
set +e
HOME="$H" PATH="$SHIM:$PATH" bash "$INSTALL" http://127.0.0.1:9999 test@example.com >/dev/null 2>&1
RC=$?
set -e
[ "$RC" -ne 0 ]; check "installer exits nonzero on producer failure" $?
AFTER="$(sha256sum "$H/.claude/settings.json" | cut -d' ' -f1)"
[ "$BEFORE" = "$AFTER" ]; check "settings.json untouched after producer failure" $?
rm -rf "$H" "$SHIM"

echo
echo "passed $PASS, failed $FAIL"
[ "$FAIL" -eq 0 ]
