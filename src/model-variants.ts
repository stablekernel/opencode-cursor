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

function paramValues(param: NonNullable<ModelListItem["parameters"]>[number]): string[] {
  return (param.values ?? []).map((v) => v.value);
}

function isBooleanParam(values: string[]): boolean {
  return values.length > 0 && values.every((v) => BOOLEAN_VALUES.has(v));
}

/**
 * Params opencode must send by DEFAULT for this model — i.e. when the user has
 * NOT picked a variant. Non-reasoning boolean toggles (notably Cursor's `fast`)
 * are pinned OFF here so the provider never silently inherits Cursor's
 * server-side default, which is `fast: true` for several models (composer-*,
 * gpt-*-codex). The user opts back IN via the matching picker variant.
 *
 * Seeded into each model's opencode `options.params` (see `toOpencodeModels` /
 * `buildModelV2Map`); {@link resolveControls} merges it into the request.
 */
export function defaultModelParams(item: ModelListItem): Record<string, string> {
  const out: Record<string, string> = {};
  for (const param of item.parameters ?? []) {
    if (REASONING_PARAM.test(param.id)) continue;
    if (isBooleanParam(paramValues(param))) out[param.id] = "false";
  }
  return out;
}

/**
 * Derive opencode model variants from a Cursor model's parameters so the
 * variant picker can expose thinking/reasoning levels plus the `fast` toggle.
 * Each variant's object is exactly what {@link resolveControls} consumes. Plan
 * mode is NOT a variant: opencode's plan agent (Tab) is mapped to Cursor's plan
 * mode by the plugin's `chat.params` hook.
 *
 * Every variant for a fast-capable model carries an explicit `fast` value
 * (reasoning variants pin it OFF via {@link defaultModelParams}; the `fast`
 * variant turns it ON) so a selection never depends on Cursor's server-side
 * default for an omitted param.
 */
export function buildModelVariants(item: ModelListItem): Record<string, CursorVariant> {
  const out: Record<string, CursorVariant> = {};
  // Non-reasoning boolean defaults (e.g. { fast: "false" }), pinned into every
  // reasoning variant so picking a reasoning level never re-enables fast.
  const defaults = defaultModelParams(item);

  for (const param of item.parameters ?? []) {
    const values = paramValues(param);
    if (values.length === 0) continue;
    const boolean = isBooleanParam(values);

    if (REASONING_PARAM.test(param.id)) {
      if (boolean) {
        // Boolean toggle (e.g. thinking=["false","true"]). Literal true/false
        // variant names are meaningless in the picker — surface a single
        // variant named after the param that switches it on. "Off" is the
        // model's default (no variant selected).
        if (values.includes("true")) {
          out[param.id.toLowerCase()] = { params: { ...defaults, [param.id]: "true" } };
        }
        continue;
      }

      for (const value of values) {
        // Key by the bare value (e.g. "high"); prefix with the param id only
        // when two params share a value (e.g. reasoning-low vs effort-low).
        const key = out[value] === undefined ? value : `${param.id}-${value}`;
        out[key] = { params: { ...defaults, [param.id]: value } };
      }
      continue;
    }

    // Non-reasoning boolean toggle (e.g. Cursor's `fast`). Default is OFF (see
    // defaultModelParams); expose a single opt-in variant that turns it ON.
    if (boolean && values.includes("true")) {
      out[param.id.toLowerCase()] = { params: { ...defaults, [param.id]: "true" } };
    }
    // Non-reasoning enum params (e.g. `context`) remain unsupported in the picker.
  }

  return out;
}
