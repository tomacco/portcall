#!/usr/bin/env bash
# Launch the Electron Glass from WSL with the repo on /mnt/c.
#
# Electron's own installer unzips unreliably onto drvfs (files silently
# vanish), so we extract its cached zip to WSL-native storage once and point
# the CLI there via ELECTRON_OVERRIDE_DIST_PATH. Run scripts/wsl-setup.sh
# first if Electron complains about missing shared libraries.
set -euo pipefail
cd "$(dirname "$0")"

npx tsc

DIST="$HOME/.local/electron-dist"
if [ ! -x "$DIST/electron" ]; then
  ZIP=$(find "$HOME/.cache/electron" -name 'electron-v*linux-x64*.zip' 2>/dev/null | head -1)
  if [ -z "$ZIP" ]; then
    echo "No cached Electron zip found — run 'npm install' in ui/ first." >&2
    exit 1
  fi
  mkdir -p "$DIST"
  unzip -qo "$ZIP" -d "$DIST"
fi

export ELECTRON_OVERRIDE_DIST_PATH="$DIST"
exec npx electron .
