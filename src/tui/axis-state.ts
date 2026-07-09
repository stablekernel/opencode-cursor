import type { ModelAxis } from "../model-axes.js";

export type AxisSelection = Record<string, string>;

/** Toggle axes whose "off" value should not appear in the compact label. */
const TOGGLE_OFF = new Set(["false"]);

export function seedSelection(axes: ModelAxis[]): AxisSelection {
  const sel: AxisSelection = {};
  for (const a of axes) sel[a.id] = a.default;
  return sel;
}

/**
 * Advance `axisId` by `dir` (+1 next, -1 prev) with wraparound. Returns a NEW
 * selection object; never mutates the input. Unknown axis id -> input echoed.
 */
export function cycleAxis(
  axes: ModelAxis[],
  sel: AxisSelection,
  axisId: string,
  dir: 1 | -1,
): AxisSelection {
  const axis = axes.find((a) => a.id === axisId);
  if (!axis) return sel;
  const cur = sel[axisId] ?? axis.default;
  const i = axis.values.indexOf(cur);
  const base = i < 0 ? 0 : i;
  const n = axis.values.length;
  const nextIdx = (base + dir + n) % n;
  const nextVal = axis.values[nextIdx];
  if (nextVal === undefined) return sel; // noUncheckedIndexedAccess guard
  return { ...sel, [axisId]: nextVal };
}

/**
 * Compact one-line label, e.g. "high · think · fast · 1m". Toggle axes only
 * appear when ON; their label word is the axis label lowercased (thinking ->
 * "think", fast -> "fast"). Non-toggle axes always show their value.
 */
export function formatSelection(axes: ModelAxis[], sel: AxisSelection): string {
  const parts: string[] = [];
  for (const a of axes) {
    const val = sel[a.id] ?? a.default;
    if (a.kind === "toggle") {
      if (!TOGGLE_OFF.has(val)) parts.push(toggleWord(a.id, a.label));
    } else {
      parts.push(val);
    }
  }
  return parts.join(" · ");
}

function toggleWord(id: string, label: string): string {
  if (id === "thinking") return "think";
  return label.toLowerCase();
}
