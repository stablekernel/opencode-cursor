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

/**
 * Derive opencode model variants from a Cursor model's parameters so the
 * variant picker can expose thinking/reasoning levels and a plan-mode option.
 * Each variant's object is exactly what {@link resolveControls} consumes.
 */
export function buildModelVariants(item: ModelListItem): Record<string, CursorVariant> {
  const out: Record<string, CursorVariant> = {};

  for (const param of item.parameters ?? []) {
    if (!REASONING_PARAM.test(param.id)) continue;
    for (const { value } of param.values ?? []) {
      // Key is unique across params; value object carries the param id+value.
      const key = param.id.toLowerCase() === "thinking" ? value : `${param.id}-${value}`;
      out[key] = { params: { [param.id]: value } };
    }
  }

  // Plan mode is orthogonal to model params and never auto-signaled by opencode,
  // so always offer it as a selectable variant.
  out["plan"] = { mode: "plan" };

  return out;
}
