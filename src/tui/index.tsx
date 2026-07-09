/** @jsxImportSource @opentui/solid */
// State bridge: this plugin persists the composed axis selection to a shared
// JSON file (src/tui/state-file.ts). The server half (src/plugin/index.ts
// chat.params) reads the SAME file and merges the params into the Cursor
// request. There is no opencode client API for per-session model options —
// the filesystem is the only cross-half channel (verified against the SDK).
import type { TuiPlugin } from "@opencode-ai/plugin/tui";
import type { ModelListItem } from "@cursor/sdk";
import { buildModelAxes, type ModelAxis } from "../model-axes.js";
import { seedSelection, type AxisSelection } from "./axis-state.js";

const PLUGIN_ID = "cursor.states";

const tui: TuiPlugin = async (api) => {
  // Per-model working state, rebuilt whenever the active Cursor model changes.
  let axes: ModelAxis[] = [];
  let selection: AxisSelection = {};

  // Resolve the active Cursor ModelListItem (with variants[]). Wired in Task 7;
  // returns undefined here so the skeleton is inert until then.
  function currentCursorModel(): ModelListItem | undefined {
    return undefined; // replaced in Task 7
  }

  function refreshForModel() {
    const model = currentCursorModel();
    axes = model ? buildModelAxes(model) : [];
    selection = seedSelection(axes);
    // Hotkey layer + slot registration added in Tasks 8 & 9.
  }

  refreshForModel();
  // Model-change event subscription added in Task 7.
};

const plugin = { id: PLUGIN_ID, tui };
export default plugin;
