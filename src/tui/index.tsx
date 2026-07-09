/** @jsxImportSource @opentui/solid */
// State bridge: this plugin persists the composed axis selection to a shared
// JSON file (src/tui/state-file.ts). The server half (src/plugin/index.ts
// chat.params) reads the SAME file and merges the params into the Cursor
// request. There is no opencode client API for per-session model options —
// the filesystem is the only cross-half channel (verified against the SDK).
import type { TuiPlugin } from "@opencode-ai/plugin/tui";
import type { ModelListItem } from "@cursor/sdk";
import { buildModelAxes, isValidCombo, snapCombo, type ModelAxis } from "../model-axes.js";
import { cachedCatalog } from "../model-discovery.js";
import {
  axisValueLabel,
  cycleAxis,
  reconcileSelection,
  seedSelection,
  type AxisSelection,
} from "./axis-state.js";
import { readSelection, writeSelection } from "./state-file.js";
import { createSignal } from "solid-js";
import { StatusWidget } from "./status-widget.js";

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
  // Identity of the (session, model) pair the current axes/selection were built
  // for. refreshForModel() no-ops until this key changes, so the many
  // `message.updated` fires per turn don't reseed and desync the selection.
  let lastKey: string | undefined;
  // Disposes the currently-registered keymap layer. Keymap auto-cleanup only
  // runs on plugin deactivation, not on our per-model re-registration, so we
  // dispose the old layer ourselves before creating a new one.
  let disposeLayer: (() => void) | undefined;

  // Solid signals mirroring `axes`/`selection` so the status widget re-renders
  // reactively as the model changes or the user cycles an axis. The widget
  // reads these getters; we push updates at the end of refreshForModel() and
  // after each cycle. New objects on write so Solid sees a fresh reference.
  const [axesSig, setAxesSig] = createSignal<ModelAxis[]>([]);
  const [selSig, setSelSig] = createSignal<AxisSelection>({});

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

  // Rebuild axes + reload the selection ONLY when the active (session, model)
  // pair changes. `message.updated` fires many times per streaming turn; the
  // key gate makes those repeat fires no-ops so the persisted selection is not
  // reseeded to defaults mid-turn. On a real change we LOAD the persisted
  // selection for the session and reconcile it to the current model's axes
  // (dropping a previous model's stale params), then persist so the file, the
  // status widget, and the server-side wire all agree.
  function refreshForModel() {
    const sessionID = activeSessionID();
    const model = currentCursorModel();
    const modelId = model?.id;
    const key = `${sessionID ?? ""}|${modelId ?? ""}`;
    if (key === lastKey) return;
    lastKey = key;

    axes = model ? buildModelAxes(model) : [];
    const persisted = sessionID ? readSelection(sessionID) : undefined;
    selection = reconcileSelection(axes, persisted);
    // Asymmetric-combo safety: a reconciled combo that isn't offered by this
    // model falls back to the always-valid per-axis defaults.
    if (model && !isValidCombo(model, selection)) selection = seedSelection(axes);
    // Re-register the hotkey layer for the (possibly new) axis set.
    registerAxisLayer();
    // Push the fresh axis set + selection into the reactive signals so the
    // status widget re-renders for the new model.
    setAxesSig(axes);
    setSelSig({ ...selection });
    // Persist the reconciled selection so file/widget/wire agree. No-op off a
    // session route.
    // Only persist once a model is actually known; writing an empty selection
    // for an unresolved model would clobber the session's saved state on resume.
    if (model) applySelection();
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
            // Mirror the new selection into the signal so the widget updates.
            setSelSig({ ...selection });
            applySelection();
            api.ui.toast({
              variant: "info",
              message: `${axis.label}: ${axisValueLabel(selection[axis.id] ?? "")}`,
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

  // Register the status widget into the host's right-of-prompt slot. Renderers
  // nest under a required `slots` key, keyed by host slot name; each value is a
  // (ctx, props) => JSX.Element renderer (params unused here). No `id` — the
  // host omits it. The widget reads the signals, so it re-renders on cycle.
  api.slots.register({
    slots: {
      session_prompt_right: () => (
        <StatusWidget axes={axesSig} selection={selSig} />
      ),
    },
  });

  // Re-derive axes whenever a message updates: `message.updated` fires when an
  // assistant message is added/updated, i.e. exactly when the model in use may
  // have changed. It also fires repeatedly during streaming, but the
  // (sessionID, modelId) gate in refreshForModel() makes those repeat fires
  // no-ops until the model or session actually changes. Dispose on unload.
  const off = api.event.on("message.updated", () => refreshForModel());
  api.lifecycle.onDispose(off);
};

const plugin = { id: PLUGIN_ID, tui };
export default plugin;
