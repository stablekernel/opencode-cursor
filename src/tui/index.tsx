/** @jsxImportSource @opentui/solid */
// State bridge: this plugin persists the composed axis selection to a shared
// JSON file (src/tui/state-file.ts). The server half (src/plugin/index.ts
// chat.params) reads the SAME file and merges the params into the Cursor
// request. There is no opencode client API for per-session model options —
// the filesystem is the only cross-half channel (verified against the SDK).
import type { TuiPlugin } from "@opencode-ai/plugin/tui";
import type { ModelListItem } from "@cursor/sdk";
import { buildModelAxes, type ModelAxis } from "../model-axes.js";
import { cachedCatalog } from "../model-discovery.js";
import { seedSelection, type AxisSelection } from "./axis-state.js";

const PLUGIN_ID = "cursor.states";

const tui: TuiPlugin = async (api) => {
  // opencode's provider id for the Cursor backend (see src/provider/index.ts).
  const PROVIDER_ID = "cursor";
  // Per-model working state, rebuilt whenever the active Cursor model changes.
  let axes: ModelAxis[] = [];
  let selection: AxisSelection = {};

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
    // Hotkey layer + slot registration added in Tasks 8 & 9.
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
