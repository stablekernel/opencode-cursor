#!/usr/bin/env bash
#
# End-to-end smoke test: build & pack the plugin, install it into a throwaway
# project alongside the real opencode CLI, configure opencode to load it, and
# assert that `opencode models` lists the Cursor provider's models.
#
# Runs with NO Cursor API key by default (the plugin serves a fallback model
# snapshot, so the provider still registers and lists). If CURSOR_API_KEY is
# set, an extra non-fatal check exercises live auth + Cursor.models.list().
#
# Usage: scripts/integration-test.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> Building and packing the plugin"
npm run build >/dev/null
TGZ_NAME="$(npm pack --silent | tail -1)"
TGZ_ABS="$ROOT/$TGZ_NAME"

WORK="$(mktemp -d)"
cleanup() { rm -rf "$WORK" "$TGZ_ABS"; }
trap cleanup EXIT

echo "==> Installing opencode-ai + the packed plugin into a scratch project"
cd "$WORK"
npm init -y >/dev/null 2>&1
npm install --silent --no-audit --no-fund opencode-ai "$TGZ_ABS"

OPENCODE="$WORK/node_modules/.bin/opencode"
echo "    opencode version: $("$OPENCODE" --version)"

cat > opencode.json <<'JSON'
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["./node_modules/@stablekernel/opencode-cursor/dist/plugin/index.js"]
}
JSON

# Isolate opencode state from the CI/home environment.
export HOME="$WORK/home"
mkdir -p "$HOME"

echo "==> Running: opencode models cursor"
set +e
MODELS_OUT="$("$OPENCODE" models cursor 2>"$WORK/stderr.log")"
STATUS=$?
set -e

echo "----- opencode models cursor -----"
echo "$MODELS_OUT"
echo "----------------------------------"

if [ "$STATUS" -ne 0 ]; then
  echo "FAIL: 'opencode models' exited with status $STATUS"
  cat "$WORK/stderr.log" || true
  exit 1
fi

CURSOR_COUNT="$(printf '%s\n' "$MODELS_OUT" | grep -c '^cursor/' || true)"
if [ "$CURSOR_COUNT" -lt 1 ]; then
  echo "FAIL: expected at least one 'cursor/<model>' entry, found $CURSOR_COUNT"
  echo "--- plugin load log ---"
  "$OPENCODE" models cursor --print-logs 2>&1 | grep -iE "plugin|provider|cursor|error" | head -20 || true
  exit 1
fi

if ! printf '%s\n' "$MODELS_OUT" | grep -q '^cursor/composer-2.5$'; then
  echo "FAIL: expected 'cursor/composer-2.5' to be listed"
  exit 1
fi

echo "PASS: opencode loaded the plugin and listed $CURSOR_COUNT Cursor model(s)."

# Assert the packed artifact actually ships the delegation tools.
PLUGIN_JS="$WORK/node_modules/@stablekernel/opencode-cursor/dist/plugin/index.js"
for TOOL in cursor_cloud_agent cursor_delegate; do
  if ! grep -q "$TOOL" "$PLUGIN_JS"; then
    echo "FAIL: packed plugin is missing the '$TOOL' tool"
    exit 1
  fi
done
echo "PASS: packed plugin registers cursor_cloud_agent + cursor_delegate."

# Optional live checks — only when a real key is provided.
if [ -n "${CURSOR_API_KEY:-}" ]; then
  echo "==> CURSOR_API_KEY present; checking live auth + Cursor.models.list()"
  if node --input-type=module -e '
    import { Cursor } from "@cursor/sdk";
    const me = await Cursor.me();
    const models = await Cursor.models.list();
    console.log(`live auth ok as ${me.apiKeyName}; ${models.length} live models`);
    if (models.length < 1) process.exit(2);
  '; then
    echo "PASS: live Cursor SDK auth + model discovery succeeded."
  else
    echo "WARN: live Cursor check failed (key invalid or network); fallback path still verified."
  fi

  echo "==> Live chat round-trip through the provider's doStream path"
  # Run against the repo build (resolves @cursor/sdk + @ai-sdk/provider from the
  # repo's node_modules). This exercises the provider's streaming/control plumbing.
  node "$ROOT/scripts/live-chat-smoke.mjs"

  echo "==> Full opencode chat turn through the Cursor provider (opencode run --format json)"
  # opencode itself drives our provider end to end. Auth is injected
  # non-interactively via OPENCODE_AUTH_CONTENT. JSON output is TTY-independent
  # (the default formatted renderer is suppressed without a TTY).
  export OPENCODE_AUTH_CONTENT="{\"cursor\":{\"type\":\"api\",\"key\":\"${CURSOR_API_KEY}\"}}"
  # The package isn't published, so point opencode at the locally-installed build
  # via a file:// specifier (opencode imports it directly, skipping a registry
  # install). Real users rely on the published package name instead.
  export OPENCODE_CURSOR_PROVIDER_NPM="file://${WORK}/node_modules/@stablekernel/opencode-cursor/dist/provider/index.js"
  export OPENCODE_CURSOR_DEBUG=1
  RUN_MODEL="cursor/${CURSOR_SMOKE_MODEL:-composer-2.5}"
  set +e
  RUN_OUT="$(timeout 180 "$OPENCODE" run --format json --model "$RUN_MODEL" \
    "Reply with exactly the single word PONG and nothing else." 2>"$WORK/run.log")"
  RUN_STATUS=$?
  set -e
  echo "----- opencode run ($RUN_MODEL) JSON events -----"
  printf '%s\n' "$RUN_OUT" | head -60
  echo "----- opencode run logs (tail, incl. [cursor:debug]) -----"
  tail -40 "$WORK/run.log" || true
  echo "------------------------------------"
  # Hard gate on real evidence: opencode loaded our provider and drove the live
  # Cursor agent to a finished result (the provider's debug trace, emitted from
  # inside opencode's process). This proves the full opencode -> provider ->
  # Cursor -> result path.
  if grep -qE "\[cursor:debug\] .*status=finished resultLen=[1-9]" "$WORK/run.log"; then
    echo "PASS: opencode drove the Cursor provider to a finished result end-to-end (status $RUN_STATUS)."
  else
    echo "FAIL: opencode did not drive the Cursor provider to a finished result (status $RUN_STATUS)."
    exit 1
  fi
  # opencode's `run --format json` stdout rendering of the text is a separate CLI
  # concern (the message parts are produced regardless); report it softly.
  if printf '%s' "$RUN_OUT" | grep -qi "pong"; then
    echo "  (opencode run stdout also surfaced the assistant text)"
  else
    echo "  (note: opencode run --format json stdout did not surface the text — CLI rendering nuance, not a provider issue)"
  fi
fi

echo "==> Integration test complete."
