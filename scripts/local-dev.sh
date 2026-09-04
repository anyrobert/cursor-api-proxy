#!/usr/bin/env bash
# Install, update, or uninstall this local cursor-api-proxy checkout.
# This script never installs the published package globally.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
LAUNCHER="$ROOT/scripts/cursor-api-proxy"
INSTALL_DIR="${CURSOR_API_PROXY_INSTALL_DIR:-$HOME/.local/bin}"
LINK="$INSTALL_DIR/cursor-api-proxy"

say() { printf '\n==> %s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

require_tools() {
  command -v bun >/dev/null 2>&1 || fail "Bun is required. Install Bun, then rerun this script."
  command -v git >/dev/null 2>&1 || fail "Git is required."
}

install_link() {
  mkdir -p "$INSTALL_DIR"
  if [[ -e "$LINK" && ! -L "$LINK" ]]; then
    fail "$LINK already exists and is not a symlink; remove it manually or set CURSOR_API_PROXY_INSTALL_DIR"
  fi
  ln -sfn "$LAUNCHER" "$LINK"
  chmod +x "$LAUNCHER"
  say "Installed local launcher: $LINK -> $LAUNCHER"
}

build_local() {
  require_tools
  say "Installing dependencies in $ROOT"
  (cd "$ROOT" && bun install)
  say "Building local checkout"
  (cd "$ROOT" && bun run build)
}

cmd_install() {
  build_local
  install_link
  cat <<EOF

Local cursor-api-proxy is ready.
  checkout: $ROOT
  command:  $LINK

Run it with:
  $LINK start

The symlink points at this checkout; no global package was installed.
EOF
}

cmd_update() {
  require_tools
  [[ -d "$ROOT/.git" ]] || fail "$ROOT is not a Git checkout"
  if [[ -n "$(cd "$ROOT" && git status --porcelain)" ]]; then
    fail "checkout has local changes; commit or stash them before update"
  fi
  say "Updating local checkout"
  (cd "$ROOT" && git pull --ff-only)
  build_local
  install_link
  say "Local checkout updated and rebuilt"
}

cmd_uninstall() {
  if [[ -L "$LINK" ]]; then
    local target
    target="$(readlink "$LINK")"
    if [[ "$target" == "$LAUNCHER" ]]; then
      say "Removing local launcher symlink"
      rm -f "$LINK"
    else
      fail "$LINK points somewhere else; refusing to remove it"
    fi
  elif [[ -e "$LINK" ]]; then
    fail "$LINK exists but is not a symlink; refusing to remove it"
  else
    say "Local launcher symlink is already absent"
  fi

  if [[ "$(uname -s)" == "Darwin" ]]; then
    "$LAUNCHER" disable >/dev/null 2>&1 || true
  fi
  say "Uninstalled launcher; source checkout was kept at $ROOT"
}

usage() {
  cat <<EOF
Usage: $0 {install|update|uninstall}

install    bun install, build, and symlink the local launcher
update     fast-forward Git, reinstall, rebuild, and refresh the symlink
uninstall  stop managing the shell command; keep this source checkout

Environment:
  CURSOR_API_PROXY_INSTALL_DIR  launcher directory (default: ~/.local/bin)
EOF
}

case "${1:-}" in
  install) cmd_install ;;
  update) cmd_update ;;
  uninstall) cmd_uninstall ;;
  -h|--help) usage ;;
  *) usage >&2; exit 2 ;;
esac
