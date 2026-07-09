/** @jsxImportSource @opentui/solid */
// State bridge: this plugin persists the composed axis selection to a shared
// JSON file (src/tui/state-file.ts). The server half (src/plugin/index.ts
// chat.params) reads the SAME file and merges the params into the Cursor
// request. There is no opencode client API for per-session model options —
// the filesystem is the only cross-half channel (verified against the SDK).
import type { TuiPlugin } from "@opencode-ai/plugin/tui";
import type { ModelListItem } from "@cursor/sdk";
import { buildModelAxes, snapCombo, type ModelAxis } from "../model-axes.js";
import { cachedCatalog } from "../model-discovery.js";
import { cycleAxis, seedSelection, type AxisSelection } from "./axis-state.js";
import { writeSelection } from "./state-file.js";

const PLUGIN_ID = "cursor.states";

// Default hotkeys per axis. shift+<key> = previous. All overridable in tui.json.
const AXIS_KEYS: Record<string, string> = {
  effort: "ctrl+e",
  reasoning: "ctrl+e", // effort and reasoning are mutually exclusive per model
  thinking: "ctrl+t",
  fast: "ctrl+f",
  context: "ctrl+k",
};

const tui: TuiPlugin = async (api) => {
  // opencode's provider id for the Cursor backend (see src/provider/index.ts).
  const PROVIDER_ID = "cursor";
  // Per-model working state, rebuilt whenever the active Cursor model changes.
  let axes: ModelAxis[] = [];
  let selection: AxisSelection = {};
  // Disposes the currently-registered keymap layer. Keymap auto-cleanup only
  // runs on plugin deactivation, not on our per-model re-registration, so we
  // dispose the old layer ourselves before creating a new one.
  let disposeLayer: (() => void) | undefined;

  // The current session id, or undefined on the home route / non-session routes.
  // `TuiRouteCurrent` also has a permissive `{ name: string; params?: ... }` arm
  // that survives the `name === "session"` narrow, so `params`/`sessionID` are
  // read defensively rather than assumed present.
  function activeSessionID(): string | undefined {
    const route = api.route.current;
    if (route.name !== "session") return undefined;
    const params: Record<string, unknown> | undefined = route.params;
    const sessionID = params?.["sessionID"];
    return typeof sessionID === "string" ? sessionID : undefined;
  }

  // The active Cursor model id = the `modelID` of the most recent ASSISTANT
  // message in the current session. opencode records provider/model per
  // assistant message; there is no model field on `Session` and no
  // model-selection event, so the transcript is the source of truth. `Message`
  // is a union — only the `role === "assistant"` arm carries top-level
  // `modelID`/`providerID` (a user message nests them under `model`), hence the
  // narrow. The `m &&` guard satisfies `noUncheckedIndexedAccess`.
  function activeCursorModelId(): string | undefined {
    const sessionID = activeSessionID();
    if (!sessionID) return undefined;
    const messages = api.state.session.messages(sessionID);
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m && m.role === "assistant" && m.providerID === PROVIDER_ID) {
        return m.modelID;
      }
    }
    return undefined;
  }

  // Resolve the active Cursor ModelListItem (with variants[]) from the cached
  // catalog. Returns undefined until a model has been used in the session.
  function currentCursorModel(): ModelListItem | undefined {
    const id = activeCursorModelId();
    if (!id) return undefined;
    return cachedCatalog().find((m) => m.id === id);
  }

  function refreshForModel() {
    const model = currentCursorModel();
    axes = model ? buildModelAxes(model) : [];
    selection = seedSelection(axes);
    // Re-register the hotkey layer for the (possibly new) axis set.
    registerAxisLayer();
  }

  // Persist the composed selection for the active session. The server half
  // (src/plugin/index.ts chat.params) reads this file and merges the params
  // into the Cursor call. No-op off a session route (nothing to key on).
  function applySelection() {
    const sessionID = activeSessionID();
    if (!sessionID) return;
    writeSelection(sessionID, selection);
  }

  // Register a keymap layer with next/prev cycle commands for each axis of the
  // current model, plus default bindings from AXIS_KEYS (shift+<key> = prev).
  // Re-runs on every model change; disposes the prior layer first.
  function registerAxisLayer() {
    disposeLayer?.();
    disposeLayer = undefined;
    if (axes.length === 0) return;

    const commands = [];
    const bindings = [];
    for (const axis of axes) {
      const key = AXIS_KEYS[axis.id];
      for (const dir of [1, -1] as const) {
        const suffix = dir === 1 ? "next" : "prev";
        const name = `cursor.axis.${axis.id}.${suffix}`;
        commands.push({
          name,
          title: `Cursor: ${axis.label} ${dir === 1 ? "next" : "previous"}`,
          category: "Cursor",
          namespace: "palette",
          run() {
            selection = cycleAxis(axes, selection, axis.id, dir);
            const model = currentCursorModel();
            if (model) selection = snapCombo(model, selection, axis.id);
            applySelection();
            api.ui.toast({
              variant: "info",
              message: `${axis.label}: ${selection[axis.id] ?? ""}`,
            });
          },
        });
        if (key) {
          const binding = dir === 1 ? key : `shift+${key}`;
          bindings.push({ key: binding, cmd: name, desc: `Cursor ${axis.label} ${suffix}` });
        }
      }
    }
    disposeLayer = api.keymap.registerLayer({ mode: "base", commands, bindings });
  }

  refreshForModel();

  // Re-derive axes whenever a message updates: `message.updated` fires when an
  // assistant message is added/updated, i.e. exactly when the model in use may
  // have changed. Dispose the listener when the plugin unloads.
  const off = api.event.on("message.updated", () => refreshForModel());
  api.lifecycle.onDispose(off);
};

const plugin = { id: PLUGIN_ID, tui };
export default plugin;
