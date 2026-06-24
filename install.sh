#!/usr/bin/env bash
#
# @stablekernel/opencode-cursor — one-line installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/stablekernel/opencode-cursor/main/install.sh | bash
#
# What it does:
#   1. Adds "@stablekernel/opencode-cursor@latest" to your opencode config
#      "plugin" array (opencode installs the npm package automatically at
#      startup; @latest makes it re-resolve to the newest release). Reuses an
#      existing opencode.jsonc or opencode.json if present (comments preserved),
#      else creates opencode.json. An older/pinned entry is upgraded in place.
#   2. Verifies Node.js 22+ is on your PATH — the plugin spawns a short-lived
#      Node sidecar to host the Cursor SDK (opencode itself runs on Bun).
#   3. Offers to set CURSOR_API_KEY in your shell profile if it is not set.
#
# Flags:
#   --project    Write ./opencode.json(c) in the current directory instead of the
#                global config (~/.config/opencode/opencode.json(c)).
#   --yes, -y    Non-interactive: skip all prompts (no API-key setup).
#   --help, -h   Show this help.
#
set -euo pipefail

PKG_NAME="@stablekernel/opencode-cursor"
# Pin to the @latest dist-tag so opencode re-resolves to the newest release.
PKG="${PKG_NAME}@latest"
REPO_URL="https://github.com/stablekernel/opencode-cursor"
MIN_NODE_MAJOR=22

SCOPE="global"
ASSUME_YES=0

# ---- pretty output -----------------------------------------------------------
if [ -t 1 ]; then
	BOLD=$'\033[1m'
	GREEN=$'\033[32m'
	YELLOW=$'\033[33m'
	RED=$'\033[31m'
	DIM=$'\033[2m'
	RESET=$'\033[0m'
else
	BOLD=""
	GREEN=""
	YELLOW=""
	RED=""
	DIM=""
	RESET=""
fi
info() { printf '%s\n' "$*"; }
ok() { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
err() { printf '%s✗%s %s\n' "$RED" "$RESET" "$*" >&2; }
step() { printf '\n%s==>%s %s\n' "$BOLD" "$RESET" "$*"; }

# ---- arg parsing -------------------------------------------------------------
while [ $# -gt 0 ]; do
	case "$1" in
	--project) SCOPE="project" ;;
	--global) SCOPE="global" ;;
	-y | --yes) ASSUME_YES=1 ;;
	-h | --help)
		sed -n '3,19p' "$0" | sed 's/^# \{0,1\}//'
		exit 0
		;;
	*)
		err "Unknown flag: $1"
		exit 2
		;;
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
else
	CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
fi

# Detect whether the user already has an opencode.json or opencode.jsonc and
# reuse whichever is in place. opencode reads both; .jsonc allows comments.
# Preference order: existing .jsonc, then existing .json, else default to .json.
if [ -f "$CONFIG_DIR/opencode.jsonc" ]; then
	CONFIG_PATH="$CONFIG_DIR/opencode.jsonc"
elif [ -f "$CONFIG_DIR/opencode.json" ]; then
	CONFIG_PATH="$CONFIG_DIR/opencode.json"
else
	CONFIG_PATH="$CONFIG_DIR/opencode.json"
fi

# jq does not understand JSONC comments; prefer node for .jsonc files.
CONFIG_IS_JSONC=0
case "$CONFIG_PATH" in
*.jsonc) CONFIG_IS_JSONC=1 ;;
esac

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
	printf '%s\n' "$1" >"$CONFIG_PATH"
}

if [ -f "$CONFIG_PATH" ]; then
	BACKUP="${CONFIG_PATH}.bak.$(date +%Y%m%d-%H%M%S)"
	cp "$CONFIG_PATH" "$BACKUP"
	info "Backed up existing config → ${DIM}${BACKUP}${RESET}"
else
	write_config '{}'
fi

UPDATED=""
# Prefer node: it edits the raw text in place, preserving comments and the
# user's formatting (essential for .jsonc, nice for .json). jq is a fallback
# for plain .json when node is unavailable (jq cannot parse JSONC comments).
if command -v node >/dev/null 2>&1; then
	# shellcheck disable=SC2016  # single-quoted block is JS source, not shell
	# NOTE: scan() and removeTrailingCommas() below are plain-JS copies of the
	# functions in src/jsonc.ts. Keep the two in sync when making changes.
	UPDATED="$(node -e '
    const fs = require("fs");
    const [p, spec, name] = [process.argv[1], process.argv[2], process.argv[3]];
    const SCHEMA = "https://opencode.ai/config.json";
    const raw = fs.readFileSync(p, "utf8");

    // Comment + string aware scan. Returns comment-stripped text plus a map
    // from stripped-index -> original raw-index, so we can locate tokens in
    // the ORIGINAL text and edit it without disturbing comments/formatting.
    function scan(s) {
      let out = "", map = [], inStr = false, i = 0;
      while (i < s.length) {
        const ch = s[i], nx = s[i + 1];
        if (inStr) {
          out += ch; map.push(i);
          if (ch === "\\") { out += (s[i + 1] || ""); map.push(i + 1); i += 2; continue; }
          if (ch === "\"") inStr = false;
          i++; continue;
        }
        if (ch === "\"") { inStr = true; out += ch; map.push(i); i++; continue; }
        if (ch === "/" && nx === "/") { while (i < s.length && s[i] !== "\n") i++; continue; }
        if (ch === "/" && nx === "*") { i += 2; while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i++; i += 2; continue; }
        out += ch; map.push(i); i++;
      }
      return { out, map };
    }

    // Find the index of the bracket matching the one at openIdx, string/comment aware.
    function matchBracket(s, openIdx) {
      let depth = 0, inStr = false, i = openIdx;
      while (i < s.length) {
        const ch = s[i], nx = s[i + 1];
        if (inStr) {
          if (ch === "\\") { i += 2; continue; }
          if (ch === "\"") inStr = false;
          i++; continue;
        }
        if (ch === "\"") { inStr = true; i++; continue; }
        if (ch === "/" && nx === "/") { while (i < s.length && s[i] !== "\n") i++; continue; }
        if (ch === "/" && nx === "*") { i += 2; while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i++; i += 2; continue; }
        if (ch === "[") depth++;
        else if (ch === "]") { depth--; if (depth === 0) return i; }
        i++;
      }
      return -1;
    }

    function lineIndent(s, idx) {
      let ls = s.lastIndexOf("\n", idx) + 1, j = ls, ind = "";
      while (j < s.length && (s[j] === " " || s[j] === "\t")) { ind += s[j]; j++; }
      return ind;
    }

    // Remove trailing commas from comment-stripped JSONC so JSON.parse accepts it.
    // Tracks string context to avoid touching commas inside string values.
    function removeTrailingCommas(s) {
      let result = "", inStr = false, i = 0;
      while (i < s.length) {
        const ch = s[i];
        if (inStr) {
          result += ch;
          if (ch === "\\") { result += (s[i + 1] || ""); i += 2; continue; }
          if (ch === "\"") inStr = false;
          i++; continue;
        }
        if (ch === "\"") { inStr = true; result += ch; i++; continue; }
        if (ch === ",") {
          let j = i + 1;
          while (j < s.length && (s[j] === " " || s[j] === "\t" || s[j] === "\n" || s[j] === "\r")) j++;
          if (j < s.length && (s[j] === "}" || s[j] === "]")) { i++; continue; }
        }
        result += ch; i++;
      }
      return result;
    }

    const { out: stripped, map } = scan(raw);
    let parsed;
    try { parsed = JSON.parse(removeTrailingCommas(stripped)); }
    catch (e) { console.error("Failed to parse " + p + ": " + e.message); process.exit(1); }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.error("Expected a JSON object in " + p); process.exit(1);
    }

    const hasSchema = Object.prototype.hasOwnProperty.call(parsed, "$schema");
    const plugin = parsed.plugin;
    const pluginIsArray = Array.isArray(plugin);
    if (plugin !== undefined && !pluginIsArray) {
      console.error("plugin in " + p + " is not an array; fix it manually."); process.exit(1);
    }

    // Match our package by name regardless of any @version suffix.
    function matchesName(v) { return v === name || (typeof v === "string" && v.indexOf(name + "@") === 0); }

    const edits = []; // { pos, del, text }

    // Locate the root object opening brace + member indentation.
    const objRel = stripped.indexOf("{");
    const objOpenRaw = map[objRel];
    const objHasExisting = Object.keys(parsed).length > 0;
    function memberIndent() {
      const nl = raw.indexOf("\n", objOpenRaw);
      if (nl === -1) return "  ";
      let i = nl + 1;
      while (i < raw.length) {
        let ind = "";
        while (i < raw.length && (raw[i] === " " || raw[i] === "\t")) { ind += raw[i]; i++; }
        if (i < raw.length && raw[i] !== "\n" && raw[i] !== "\r") return ind || "  ";
        while (i < raw.length && raw[i] !== "\n") i++;
        i++;
      }
      return "  ";
    }

    function arraySpan() {
      const m = /"plugin"\s*:\s*\[/.exec(stripped);
      const open = map[m.index + m[0].length - 1];
      return { open, close: matchBracket(raw, open) };
    }

    let pluginNeedsMember = false;
    if (pluginIsArray) {
      const nameIdxs = plugin.map((v, i) => (matchesName(v) ? i : -1)).filter((i) => i >= 0);
      if (nameIdxs.length === 0) {
        // Insert spec into the existing array, preserving its layout.
        const { open, close } = arraySpan();
        const inner = raw.slice(open + 1, close);
        const hasElems = scan(inner).out.trim() !== "";
        const multiline = inner.indexOf("\n") !== -1;
        const elemIndent = lineIndent(raw, open) + "  ";
        let text;
        if (!hasElems && !multiline) text = "\"" + spec + "\"";
        else if (!hasElems && multiline) text = "\n" + elemIndent + "\"" + spec + "\"";
        else if (hasElems && !multiline) text = "\"" + spec + "\", ";
        else text = "\n" + elemIndent + "\"" + spec + "\",";
        edits.push({ pos: open + 1, del: 0, text });
      } else {
        const firstVal = plugin[nameIdxs[0]];
        if (firstVal !== spec) {
          // Upgrade the existing entry to the @latest spec, in place.
          const { open, close } = arraySpan();
          const target = "\"" + firstVal + "\"";
          const at = raw.indexOf(target, open);
          if (at !== -1 && at < close) edits.push({ pos: at, del: target.length, text: "\"" + spec + "\"" });
        }
        // else: already pinned to @latest — nothing to do.
      }
    } else {
      pluginNeedsMember = true;
    }

    // Insert missing top-level members ($schema and/or plugin) after the brace.
    const newMembers = [];
    if (!hasSchema) newMembers.push("\"$schema\": \"" + SCHEMA + "\"");
    if (pluginNeedsMember) newMembers.push("\"plugin\": [\"" + spec + "\"]");
    if (newMembers.length) {
      const ind = memberIndent();
      let text = "";
      for (let k = 0; k < newMembers.length; k++) {
        text += "\n" + ind + newMembers[k];
        if (k < newMembers.length - 1 || objHasExisting) text += ",";
      }
      if (!objHasExisting) text += "\n";
      edits.push({ pos: objOpenRaw + 1, del: 0, text });
    }

    if (edits.length === 0) { process.stdout.write(raw); process.exit(0); }
    edits.sort((a, b) => b.pos - a.pos);
    let result = raw;
    for (const e of edits) result = result.slice(0, e.pos) + e.text + result.slice(e.pos + e.del);
    process.stdout.write(result);
  ' "$CONFIG_PATH" "$PKG" "$PKG_NAME")" || {
		err "Failed to update $CONFIG_PATH"
		exit 1
	}
elif [ "$CONFIG_IS_JSONC" -eq 0 ] && command -v jq >/dev/null 2>&1; then
	UPDATED="$(jq \
		--arg name "$PKG_NAME" \
		--arg spec "$PKG" \
		--arg schema "https://opencode.ai/config.json" '
      (.["$schema"] //= $schema)
      | .plugin = (
          ((.plugin // [])
            | map(select(. != $name and (startswith($name + "@") | not))))
          + [$spec]
        )
    ' "$CONFIG_PATH")" || {
		err "jq failed to parse $CONFIG_PATH"
		exit 1
	}
else
	if [ "$CONFIG_IS_JSONC" -eq 1 ]; then
		err "Editing $CONFIG_PATH (JSONC) requires Node.js."
	else
		err "Neither node nor jq is available to edit JSON safely."
	fi
	err "Add \"$PKG\" to the \"plugin\" array in $CONFIG_PATH manually."
	exit 1
fi

# Validate before writing. Skip for JSONC: jq cannot parse comments, and the
# node editor only inserts well-formed tokens into already-valid input.
if [ "$CONFIG_IS_JSONC" -eq 0 ] && command -v jq >/dev/null 2>&1; then
	printf '%s' "$UPDATED" | jq empty >/dev/null 2>&1 || {
		err "Refusing to write invalid JSON."
		exit 1
	}
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
	read -r REPLY <"$TTY" || REPLY=""
	case "$REPLY" in
	[yY]*)
		printf 'Paste your Cursor API key (key_...): '
		read -r KEY <"$TTY" || KEY=""
		if [ -n "$KEY" ]; then
			case "${SHELL:-}" in
			*zsh) PROFILE="$HOME/.zshrc" ;;
			*bash) PROFILE="$HOME/.bashrc" ;;
			*) PROFILE="$HOME/.profile" ;;
			esac
			printf '\n# opencode-cursor\nexport CURSOR_API_KEY=%q\n' "$KEY" >>"$PROFILE"
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
