import { describe, expect, it } from "vitest";
import type { ModelAxis } from "../src/model-axes.js";
import type { AxisSelection } from "../src/tui/axis-state.js";
import { seedSelection, cycleAxis, formatSelection } from "../src/tui/axis-state.js";

const AXES: ModelAxis[] = [
  { id: "effort", label: "Effort", values: ["low", "medium", "high", "xhigh", "max"], default: "high", kind: "cycle" },
  { id: "fast", label: "Fast", values: ["false", "true"], default: "false", kind: "toggle" },
];

describe("axis-state", () => {
  it("seeds from each axis default", () => {
    expect(seedSelection(AXES)).toEqual({ effort: "high", fast: "false" });
  });

  it("cycles forward and wraps", () => {
    let sel: AxisSelection = { effort: "xhigh", fast: "false" };
    sel = cycleAxis(AXES, sel, "effort", 1);
    expect(sel.effort).toBe("max");
    sel = cycleAxis(AXES, sel, "effort", 1);
    expect(sel.effort).toBe("low"); // wrapped
  });

  it("cycles backward and wraps", () => {
    const sel = cycleAxis(AXES, { effort: "low", fast: "false" }, "effort", -1);
    expect(sel.effort).toBe("max");
  });

  it("does not mutate the input selection", () => {
    const sel = { effort: "high", fast: "false" };
    cycleAxis(AXES, sel, "effort", 1);
    expect(sel.effort).toBe("high");
  });

  it("ignores an unknown axis id", () => {
    const sel = { effort: "high", fast: "false" };
    expect(cycleAxis(AXES, sel, "nope", 1)).toEqual(sel);
  });

  it("formats a compact label line", () => {
    expect(formatSelection(AXES, { effort: "high", fast: "true" })).toBe("high · fast");
  });

  it("omits the OFF value of toggles from the label", () => {
    // fast=false is the off state -> not shown; effort always shown.
    expect(formatSelection(AXES, { effort: "low", fast: "false" })).toBe("low");
  });
});
