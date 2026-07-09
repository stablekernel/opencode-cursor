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
  reasoning: ["none", "low", "medium", "high", "extra-high"],
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
