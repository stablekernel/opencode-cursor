import type { ModelListItem } from "@cursor/sdk";
import { buildModelAxes } from "./model-axes.js";

/**
 * A Cursor model "variant" as opencode stores it: an options object that, when
 * the variant is selected, is merged into `providerOptions.cursor` and read back
 * by {@link resolveControls}.
 */
export interface CursorVariant {
  params?: Record<string, string>;
  mode?: "agent" | "plan";
}

/**
 * Curated flat variant map for opencode's NATIVE variant_cycle (the --pure /
 * no-tui fallback). One entry per non-default axis value, varying ONE axis at a
 * time from the model defaults — a short list, never the full cartesian product.
 */
export function buildModelVariants(item: ModelListItem): Record<string, CursorVariant> {
  const axes = buildModelAxes(item);
  const out: Record<string, CursorVariant> = {};
  const base: Record<string, string> = {};
  for (const a of axes) base[a.id] = a.default;

  for (const a of axes) {
    for (const value of a.values) {
      if (value === a.default) continue;
      if (a.kind === "toggle" && value === "false") continue; // off = baseline
      const label = variantLabel(a.id, value);
      out[label] = { params: { ...base, [a.id]: value } };
    }
  }
  return out;
}

function variantLabel(axisId: string, value: string): string {
  if (axisId === "thinking" && value === "true") return "thinking";
  if (axisId === "fast" && value === "true") return "fast";
  if (value === "extra-high") return "xhigh";
  return value;
}

/** Baseline params to seed a model's default request (axis defaults + pinned). */
export function defaultModelParams(item: ModelListItem): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of buildModelAxes(item)) out[a.id] = a.default;
  // Pinned single-value params (never axes) still belong in the baseline.
  const counts = new Map<string, Set<string>>();
  for (const v of item.variants ?? [])
    for (const p of v.params ?? []) (counts.get(p.id) ?? counts.set(p.id, new Set()).get(p.id)!).add(p.value);
  for (const [id, set] of counts) {
    if (set.size === 1) {
      const only = [...set][0];
      if (only !== undefined) out[id] = only;
    }
  }
  return out;
}
