#!/usr/bin/env bash
#
# @stablekernel/opencode-cursor — one-line installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/stablekernel/opencode-cursor/main/install.sh | bash
#
# What it does:
#   1. Adds "@stablekernel/opencode-cursor" to your opencode.json "plugin" array
#      (opencode installs the npm package automatically at startup).
#   2. Verifies Node.js 22+ is on your PATH — the plugin spawns a short-lived
#      Node sidecar to host the Cursor SDK (opencode itself runs on Bun).
#   3. Offers to set CURSOR_API_KEY in your shell profile if it is not set.
#
# Flags:
#   --project    Write ./opencode.json in the current directory instead of the
#                global config (~/.config/opencode/opencode.json).
#   --yes, -y    Non-interactive: skip all prompts (no API-key setup).
#   --help, -h   Show this help.
#
set -euo pipefail

PKG="@stablekernel/opencode-cursor"
REPO_URL="https://github.com/stablekernel/opencode-cursor"
MIN_NODE_MAJOR=22

SCOPE="global"
ASSUME_YES=0

# ---- pretty output -----------------------------------------------------------
if [ -t 1 ]; then
  BOLD=$'\033[1m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; DIM=$'\033[2m'; RESET=$'\033[0m'
else
  BOLD=""; GREEN=""; YELLOW=""; RED=""; DIM=""; RESET=""
fi
info()  { printf '%s\n' "$*"; }
ok()    { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn()  { printf '%s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
err()   { printf '%s✗%s %s\n' "$RED" "$RESET" "$*" >&2; }
step()  { printf '\n%s==>%s %s\n' "$BOLD" "$RESET" "$*"; }

# ---- arg parsing -------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --project) SCOPE="project" ;;
    --global)  SCOPE="global" ;;
    -y|--yes)  ASSUME_YES=1 ;;
    -h|--help)
      sed -n '3,19p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) err "Unknown flag: $1"; exit 2 ;;
  esac
  shift
done

# Reading prompts works even when the script is piped via `curl | bash`,
# as long as a controlling terminal exists.
TTY="/dev/tty"
have_tty() { [ -e "$TTY" ] && [ "$ASSUME_YES" -eq 0 ]; }

# ---- resolve config path -----------------------------------------------------
if [ "$SCOPE" = "project" ]; then
  CONFIG_DIR="$(pwd)"
  CONFIG_PATH="$CONFIG_DIR/opencode.json"
else
  CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
  CONFIG_PATH="$CONFIG_DIR/opencode.json"
fi

info "${BOLD}opencode-cursor installer${RESET}"
info "${DIM}${REPO_URL}${RESET}"
info "Scope:  $SCOPE"
info "Config: $CONFIG_PATH"

# ---- 1. Node.js 22+ check ----------------------------------------------------
step "Checking Node.js (>= ${MIN_NODE_MAJOR}) on PATH"
if command -v node >/dev/null 2>&1; then
  NODE_VER="$(node --version 2>/dev/null | sed 's/^v//')"
  NODE_MAJOR="${NODE_VER%%.*}"
  if [ "${NODE_MAJOR:-0}" -ge "$MIN_NODE_MAJOR" ] 2>/dev/null; then
    ok "node v${NODE_VER}"
  else
    warn "node v${NODE_VER} found, but the plugin needs Node ${MIN_NODE_MAJOR}+."
    warn "opencode runs on Bun and spawns a Node sidecar for the Cursor SDK."
    warn "Install Node ${MIN_NODE_MAJOR}+ (https://nodejs.org) and ensure it is on your PATH."
  fi
else
  warn "node not found on PATH."
  warn "The plugin spawns a short-lived Node process to host the Cursor SDK."
  warn "Install Node ${MIN_NODE_MAJOR}+ (https://nodejs.org) before using cursor/* models."
fi

# ---- 2. Add plugin to opencode.json ------------------------------------------
step "Registering plugin in opencode.json"
mkdir -p "$CONFIG_DIR"

write_config() {
  # $1 = json content
  printf '%s\n' "$1" > "$CONFIG_PATH"
}

if [ -f "$CONFIG_PATH" ]; then
  BACKUP="${CONFIG_PATH}.bak.$(date +%Y%m%d-%H%M%S)"
  cp "$CONFIG_PATH" "$BACKUP"
  info "Backed up existing config → ${DIM}${BACKUP}${RESET}"
else
  write_config '{}'
fi

UPDATED=""
if command -v jq >/dev/null 2>&1; then
  UPDATED="$(jq \
    --arg pkg "$PKG" \
    --arg schema "https://opencode.ai/config.json" '
      (.["$schema"] //= $schema)
      | .plugin = ((.plugin // []) + [$pkg] | unique)
    ' "$CONFIG_PATH")" || { err "jq failed to parse $CONFIG_PATH"; exit 1; }
elif command -v node >/dev/null 2>&1; then
  # shellcheck disable=SC2016  # single-quoted block is JS source, not shell
  UPDATED="$(node -e '
    const fs = require("fs");
    const [p, pkg] = [process.argv[1], process.argv[2]];
    let c = {};
    try { c = JSON.parse(fs.readFileSync(p, "utf8")); }
    catch (e) { console.error("Failed to parse " + p + ": " + e.message); process.exit(1); }
    c["$schema"] = c["$schema"] || "https://opencode.ai/config.json";
    c.plugin = Array.isArray(c.plugin) ? c.plugin : [];
    if (!c.plugin.includes(pkg)) c.plugin.push(pkg);
    process.stdout.write(JSON.stringify(c, null, 2));
  ' "$CONFIG_PATH" "$PKG")" || { err "Failed to update $CONFIG_PATH"; exit 1; }
else
  err "Neither jq nor node is available to edit JSON safely."
  err "Add \"$PKG\" to the \"plugin\" array in $CONFIG_PATH manually."
  exit 1
fi

# Validate before writing.
if command -v jq >/dev/null 2>&1; then
  printf '%s' "$UPDATED" | jq empty >/dev/null 2>&1 || { err "Refusing to write invalid JSON."; exit 1; }
fi
write_config "$UPDATED"
ok "Plugin \"$PKG\" present in $CONFIG_PATH"

# ---- 3. CURSOR_API_KEY -------------------------------------------------------
step "Cursor API key"
if [ -n "${CURSOR_API_KEY:-}" ]; then
  ok "CURSOR_API_KEY is already set in this environment."
elif have_tty; then
  info "The plugin reads ${BOLD}CURSOR_API_KEY${RESET} (get it from the Cursor dashboard)."
  printf 'Set it now in your shell profile? [y/N] '
  read -r REPLY < "$TTY" || REPLY=""
  case "$REPLY" in
    [yY]*)
      printf 'Paste your Cursor API key (key_...): '
      read -r KEY < "$TTY" || KEY=""
      if [ -n "$KEY" ]; then
        case "${SHELL:-}" in
          *zsh)  PROFILE="$HOME/.zshrc" ;;
          *bash) PROFILE="$HOME/.bashrc" ;;
          *)     PROFILE="$HOME/.profile" ;;
        esac
        printf '\n# opencode-cursor\nexport CURSOR_API_KEY=%q\n' "$KEY" >> "$PROFILE"
        ok "Added export to $PROFILE — run: source $PROFILE"
      else
        warn "No key entered; skipping."
      fi
      ;;
    *) info "Skipped. Set it later: ${DIM}export CURSOR_API_KEY=\"key_...\"${RESET} or run ${DIM}opencode auth login${RESET}." ;;
  esac
else
  warn "CURSOR_API_KEY is not set."
  info "Set it with ${DIM}export CURSOR_API_KEY=\"key_...\"${RESET} or run ${DIM}opencode auth login${RESET} (choose \"Cursor\")."
fi

# ---- done --------------------------------------------------------------------
step "Done"
ok "opencode-cursor is installed."
info "Next:"
info "  1. ${DIM}Ensure CURSOR_API_KEY is set, or run: opencode auth login${RESET}"
info "  2. ${DIM}Restart opencode, then run: opencode models${RESET}  (lists cursor/* models)"
info ""
info "Docs: ${DIM}${REPO_URL}#readme${RESET}"
