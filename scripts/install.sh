#!/usr/bin/env bash
# Checkout-owned CLI only; AgentStart owns launchd registration/supervision.
set -euo pipefail
umask 077
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
SOURCE="$ROOT/src/main.ts"
BIN_DIR="${AGENTACP_INSTALL_BIN_DIR:-$HOME/.local/bin}"
STATE_DIR="${AGENTACP_INSTALL_STATE_DIR:-$HOME/.local/state/agentacp}"
TARGET="$BIN_DIR/agentacp"
die() { printf 'agentacp installer: %s\n' "$*" >&2; exit 1; }
[[ $# -le 1 ]] || die "expected at most one option"
[[ "$BIN_DIR" == /* && "$STATE_DIR" == /* ]] || die "installation paths must be absolute"
owned_link() {
  [[ -L "$TARGET" ]] || die "refusing to replace a non-link at $TARGET"
  case "$(readlink "$TARGET")" in "$ROOT"/*) ;; *) die "link belongs to another checkout: $TARGET" ;; esac
}
safe_state() {
  [[ ! -L "$STATE_DIR" ]] || die "state directory must not be a symlink"
  [[ ! -L "$STATE_DIR/deployed-sha" ]] || die "deployed-sha must not be a symlink"
  [[ ! -e "$STATE_DIR/deployed-sha" || -f "$STATE_DIR/deployed-sha" ]] || die "deployed-sha must be a regular file"
}
case "${1:---install}" in
  --install)
    command -v bun >/dev/null || die "bun is required"
    [[ -f "$SOURCE" ]] || die "missing $SOURCE"
    (cd "$ROOT" && bun install --frozen-lockfile >/dev/null) || die "frozen dependency install failed"
    safe_state
    mkdir -p "$BIN_DIR" "$STATE_DIR"
    if [[ -e "$TARGET" || -L "$TARGET" ]]; then owned_link; fi
    chmod +x "$SOURCE"
    ln -sfn "$SOURCE" "$TARGET"
    git -C "$ROOT" rev-parse HEAD > "$STATE_DIR/deployed-sha"
    printf 'Installed %s -> %s\n' "$TARGET" "$SOURCE"
    ;;
  --uninstall)
    if [[ -L "$TARGET" ]]; then
      owned_link
      safe_state
      rm -f "$TARGET"
      rm -f "$STATE_DIR/deployed-sha"
      printf 'Removed %s\n' "$TARGET"
    else printf 'Nothing installed at %s\n' "$TARGET"; fi
    ;;
  --help|-h) printf 'Usage: scripts/install.sh [--install|--uninstall]\n' ;;
  *) die "unknown option $1" ;;
esac
