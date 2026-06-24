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

  // Pre-pass: does any reasoning param expose a non-boolean effort enum (e.g.
  // ["low","medium","high","xhigh","max"])? When it does, a coexisting boolean
  // reasoning toggle (Cursor's `thinking=["false","true"]` on claude-* models)
  // is redundant — selecting any effort level already enables reasoning — and
  // surfacing it would add a stray `thinking` variant the standard opencode
  // providers don't show. Suppress the boolean variant for parity. Order-
  // independent: the enum may be declared before or after the boolean.
  const hasEffortEnum = (item.parameters ?? []).some(
    (p) => REASONING_PARAM.test(p.id) && !isBooleanParam(paramValues(p)) && paramValues(p).length > 0,
  );

  for (const param of item.parameters ?? []) {
    const values = paramValues(param);
    if (values.length === 0) continue;
    const boolean = isBooleanParam(values);

    if (REASONING_PARAM.test(param.id)) {
      if (boolean) {
        // Boolean toggle (e.g. thinking=["false","true"]). Literal true/false
        // variant names are meaningless in the picker — surface a single
        // variant named after the param that switches it on. "Off" is the
        // model's default (no variant selected). Skipped entirely when an
        // effort enum coexists (see hasEffortEnum above).
        if (!hasEffortEnum && values.includes("true")) {
          out[param.id.toLowerCase()] = { params: { ...defaults, [param.id]: "true" } };
        }
        continue;
      }

      for (const value of values) {
        // `none` means reasoning OFF — the model's default when no variant is
        // selected. Surfacing it as a selectable variant is meaningless (you
        // get it by picking nothing), so skip it. Standard providers
        // (models.dev) include `none` in their effort values, but the
        // no-variant-selected state already represents it.
        if (value === "none") continue;
        // Cursor labels the top reasoning tier "extra-high"; the opencode
        // standard (models.dev) calls it "xhigh". Use the standard label for
        // the variant key so the cycler is consistent across providers, but
        // keep the Cursor wire-format value ("extra-high") in the params sent
        // to the API.
        const displayKey = value === "extra-high" ? "xhigh" : value;
        const key = out[displayKey] === undefined ? displayKey : `${param.id}-${displayKey}`;
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
