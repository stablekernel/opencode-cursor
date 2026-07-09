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
 * Rebuild a selection for `axes` from a previously-persisted selection: carry
 * over each axis value that is still valid for THIS model's axes, fall back to
 * the axis default otherwise, and DROP any persisted keys that are not axes of
 * this model (e.g. left over from a different model). Pure; never mutates input.
 */
export function reconcileSelection(
  axes: ModelAxis[],
  persisted: AxisSelection | undefined,
): AxisSelection {
  const sel = seedSelection(axes);
  if (!persisted) return sel;
  for (const a of axes) {
    const v = persisted[a.id];
    if (v !== undefined && a.values.includes(v)) sel[a.id] = v;
  }
  return sel;
}

/** Map a raw Cursor value to its display token (wire `extra-high` shows as `xhigh`). */
export function axisValueLabel(value: string): string {
  return value === "extra-high" ? "xhigh" : value;
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
      parts.push(axisValueLabel(val));
    }
  }
  return parts.join(" · ");
}

function toggleWord(id: string, label: string): string {
  if (id === "thinking") return "think";
  return label.toLowerCase();
}
