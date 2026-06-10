import type { ModelListItem } from "@cursor/sdk";

/**
 * A Cursor model "variant" as opencode stores it: an options object that, when
 * the variant is selected, is merged into `providerOptions.cursor` and read back
 * by {@link resolveControls}.
 */
export interface CursorVariant {
  params?: Record<string, string>;
  mode?: "agent" | "plan";
}

const REASONING_PARAM = /think|reason|effort/i;
const BOOLEAN_VALUES = new Set(["true", "false"]);

/**
 * Derive opencode model variants from a Cursor model's parameters so the
 * variant picker can expose thinking/reasoning levels. Each variant's object is
 * exactly what {@link resolveControls} consumes. Plan mode is NOT a variant:
 * opencode's plan agent (Tab) is mapped to Cursor's plan mode by the plugin's
 * `chat.params` hook.
 */
export function buildModelVariants(item: ModelListItem): Record<string, CursorVariant> {
  const out: Record<string, CursorVariant> = {};

  for (const param of item.parameters ?? []) {
    if (!REASONING_PARAM.test(param.id)) continue;
    const values = (param.values ?? []).map((v) => v.value);
    if (values.length === 0) continue;

    if (values.every((v) => BOOLEAN_VALUES.has(v))) {
      // Boolean toggle (e.g. thinking=["false","true"]). Literal true/false
      // variant names are meaningless in the picker — surface a single
      // variant named after the param that switches it on. "Off" is the
      // model's default (no variant selected).
      if (values.includes("true")) {
        out[param.id.toLowerCase()] = { params: { [param.id]: "true" } };
      }
      continue;
    }

    for (const value of values) {
      // Key by the bare value (e.g. "high"); prefix with the param id only
      // when two params share a value (e.g. reasoning-low vs effort-low).
      const key = out[value] === undefined ? value : `${param.id}-${value}`;
      out[key] = { params: { [param.id]: value } };
    }
  }

  return out;
}
