#!/usr/bin/env bash
# Builds the Swift widget, installs it to ~/.local/bin, and registers a
# LaunchAgent so it auto-starts at login. Completely independent of the
# Bun proxy — failure here cannot affect the proxy process.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
INSTALL_DIR="${HOME}/.local/bin"
BIN_NAME="cursor-proxy-widget"
LABEL="com.cursor-api-proxy.widget"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"

cd "$SCRIPT_DIR"

echo ">> Building widget (release)..."
swift build -c release

BUILT="$(swift build -c release --show-bin-path)/CursorProxyWidget"
if [[ ! -x "$BUILT" ]]; then
  echo "Build artifact not found at $BUILT" >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"
cp "$BUILT" "$INSTALL_DIR/$BIN_NAME"
echo ">> Installed $INSTALL_DIR/$BIN_NAME"

CLI_PATH="$INSTALL_DIR/cursor-api-proxy"
if [[ ! -e "$CLI_PATH" ]]; then
  REPO_CLI="${REPO_ROOT}/scripts/cursor-api-proxy"
  if [[ -x "$REPO_CLI" ]]; then
    ln -s "$REPO_CLI" "$CLI_PATH"
    echo ">> Symlinked CLI: $CLI_PATH -> $REPO_CLI"
  else
    echo "!! cursor-api-proxy CLI missing; start/stop/restart will fail until you install it."
    echo "   Override with: export CURSOR_PROXY_WIDGET_CLI=/path/to/cursor-api-proxy"
  fi
fi

mkdir -p "$(dirname "$PLIST")" "$HOME/Library/Logs"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${INSTALL_DIR}/${BIN_NAME}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${HOME}/Library/Logs/cursor-proxy-widget.out.log</string>
  <key>StandardErrorPath</key><string>${HOME}/Library/Logs/cursor-proxy-widget.err.log</string>
</dict>
</plist>
EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo ">> LaunchAgent loaded: ${LABEL}"
echo "Done. Look for the colored dot in your menu bar (green = running, red = offline)."
echo "Logs: ~/Library/Logs/cursor-proxy-widget.log"
