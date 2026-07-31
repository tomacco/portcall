#!/usr/bin/env bash
# One-time WSL setup for PortCall. Safe to re-run.
set -euo pipefail

echo "== PortCall WSL setup =="

# Node >= 23.6 (native TypeScript type-stripping)
if command -v node >/dev/null 2>&1 && [ "$(node -p 'Number(process.versions.node.split(".")[0])')" -ge 24 ]; then
  echo "node $(node --version) OK"
else
  echo "Installing Node LTS via nvm..."
  if [ ! -d "$HOME/.nvm" ]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  fi
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm install --lts
fi

# Electron's shared libraries for WSLg (needs sudo; skip silently if not available)
if command -v apt-get >/dev/null 2>&1; then
  echo "Installing Electron/WSLg libraries (sudo)..."
  sudo apt-get update -qq && sudo apt-get install -y -qq \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libgtk-3-0 \
    libgbm1 libasound2t64 libxcomposite1 libxdamage1 libxrandr2 libxkbcommon0 \
    || echo "(couldn't install Electron libs — the browser UI at http://localhost:4747 works regardless)"
fi

echo
echo "Done. Open the harbor with:  node src/daemon.ts"
