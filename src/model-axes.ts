import type { ModelListItem } from "@cursor/sdk";

export interface ModelAxis {
  /** The Cursor param id: "effort" | "reasoning" | "thinking" | "fast" | "context" | ... */
  id: string;
  /** Human label for UI, e.g. "Effort". */
  label: string;
  /** Distinct values in stable, meaningful order. */
  values: string[];
  /** Seed value: from the isDefault variant, else values[0]. */
  default: string;
  /** ">2 values" = cycle, exactly 2 = toggle. */
  kind: "cycle" | "toggle";
}

// Preferred value orderings so cyclers advance in an intuitive direction.
// Any value not listed keeps first-seen order, appended after known ones.
const VALUE_ORDER: Record<string, string[]> = {
  effort: ["low", "medium", "high", "xhigh", "max"],
  reasoning: ["none", "low", "medium", "high", "extra-high", "xhigh", "max"],
  context: ["200k", "272k", "300k", "1m"],
  thinking: ["false", "true"],
  fast: ["false", "true"],
};

const LABELS: Record<string, string> = {
  effort: "Effort",
  reasoning: "Reasoning",
  thinking: "Thinking",
  fast: "Fast",
  context: "Context",
};

function orderValues(id: string, seen: string[]): string[] {
  const pref = VALUE_ORDER[id];
  if (!pref) return seen;
  const known = pref.filter((v) => seen.includes(v));
  const extra = seen.filter((v) => !pref.includes(v));
  return [...known, ...extra];
}

/**
 * Group the model's enumerated variants by param id into independent axes.
 * A param that only ever has one value across all variants is pinned (not an
 * axis). Default per axis is taken from the variant flagged isDefault.
 */
export function buildModelAxes(item: ModelListItem): ModelAxis[] {
  const variants = item.variants ?? [];
  if (variants.length <= 1) return [];

  // Collect distinct values per param id, and the default variant's value.
  const valuesById = new Map<string, Set<string>>();
  const defaultVariant = variants.find((v) => v.isDefault);
  const defaultById = new Map<string, string>();

  for (const v of variants) {
    for (const p of v.params ?? []) {
      let set = valuesById.get(p.id);
      if (!set) {
        set = new Set<string>();
        valuesById.set(p.id, set);
      }
      set.add(p.value);
    }
  }
  for (const p of defaultVariant?.params ?? []) {
    defaultById.set(p.id, p.value);
  }

  const axes: ModelAxis[] = [];
  for (const [id, set] of valuesById) {
    if (set.size <= 1) continue; // pinned param (e.g. cyber=false) -> not an axis
    const values = orderValues(id, [...set]);
    const fallback = values[0];
    if (fallback === undefined) continue; // satisfies noUncheckedIndexedAccess
    const def = defaultById.get(id) ?? fallback;
    axes.push({
      id,
      label: LABELS[id] ?? id,
      values,
      default: def,
      kind: values.length === 2 ? "toggle" : "cycle",
    });
  }
  return axes;
}

/** Serialize a param map to a stable key for set membership. */
function comboKey(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("|");
}

/** Build the set of all offered variant combos (over the axis param ids). */
function offeredCombos(item: ModelListItem, axisIds: string[]): Set<string> {
  const out = new Set<string>();
  for (const v of item.variants ?? []) {
    const proj: Record<string, string> = {};
    for (const p of v.params ?? []) {
      if (axisIds.includes(p.id)) proj[p.id] = p.value;
    }
    out.add(comboKey(proj));
  }
  return out;
}

/**
 * True if `params` (restricted to the model's axis ids) matches an offered
 * variant. Params outside the axis set are ignored.
 */
export function isValidCombo(item: ModelListItem, params: Record<string, string>): boolean {
  const axisIds = buildModelAxes(item).map((a) => a.id);
  if (axisIds.length === 0) return true;
  const proj: Record<string, string> = {};
  for (const id of axisIds) {
    const val = params[id];
    if (val !== undefined) proj[id] = val;
  }
  return offeredCombos(item, axisIds).has(comboKey(proj));
}

/**
 * If `params` is invalid after changing `changedAxisId`, adjust the OTHER axes
 * to the nearest offered combo that preserves the changed axis's value. Picks
 * the first offered variant whose changed-axis value matches; falls back to the
 * default variant if none match. Never mutates the changed axis.
 */
export function snapCombo(
  item: ModelListItem,
  params: Record<string, string>,
  changedAxisId: string,
): Record<string, string> {
  if (isValidCombo(item, params)) return params;
  const axisIds = buildModelAxes(item).map((a) => a.id);
  const target = params[changedAxisId];

  // Prefer an offered variant that keeps the changed axis value.
  for (const v of item.variants ?? []) {
    const proj: Record<string, string> = {};
    for (const p of v.params ?? []) {
      if (axisIds.includes(p.id)) proj[p.id] = p.value;
    }
    if (proj[changedAxisId] === target) return proj;
  }

  // No variant supports the changed value together with anything: fall back to
  // the default variant's projection.
  const def = (item.variants ?? []).find((v) => v.isDefault) ?? (item.variants ?? [])[0];
  const proj: Record<string, string> = {};
  for (const p of def?.params ?? []) {
    if (axisIds.includes(p.id)) proj[p.id] = p.value;
  }
  return proj;
}
