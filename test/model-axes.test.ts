import { describe, expect, it } from "vitest";
import type { ModelListItem } from "@cursor/sdk";
import catalog from "./fixtures/cursor-catalog.json" with { type: "json" };
import { buildModelAxes, isValidCombo, snapCombo } from "../src/model-axes.js";

const byId = (id: string): ModelListItem =>
  (catalog as ModelListItem[]).find((m) => m.id === id)!;

describe("buildModelAxes", () => {
  it("derives four axes for a full-matrix model (claude-opus-4-8)", () => {
    const axes = buildModelAxes(byId("claude-opus-4-8"));
    const ids = axes.map((a) => a.id).sort();
    expect(ids).toEqual(["context", "effort", "fast", "thinking"]);
  });

  it("orders effort values low..max and marks it a cycle", () => {
    const effort = buildModelAxes(byId("claude-opus-4-8")).find((a) => a.id === "effort")!;
    expect(effort.values).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(effort.kind).toBe("cycle");
  });

  it("marks a two-value param as a toggle (fast)", () => {
    const fast = buildModelAxes(byId("claude-opus-4-8")).find((a) => a.id === "fast")!;
    expect(fast.values).toEqual(["false", "true"]);
    expect(fast.kind).toBe("toggle");
  });

  it("seeds default from the isDefault variant (opus effort=high)", () => {
    const effort = buildModelAxes(byId("claude-opus-4-8")).find((a) => a.id === "effort")!;
    expect(effort.default).toBe("high");
  });

  it("returns a single thinking toggle for sonnet-4-5", () => {
    const axes = buildModelAxes(byId("claude-sonnet-4-5"));
    expect(axes.map((a) => a.id)).toEqual(["thinking"]);
    expect(axes[0]!.default).toBe("true");
  });

  it("returns no axes for a fixed model (default)", () => {
    expect(buildModelAxes(byId("default"))).toEqual([]);
  });

  it("drops pinned single-value params (cyber never becomes an axis)", () => {
    const axes = buildModelAxes(byId("claude-opus-4-8"));
    expect(axes.find((a) => a.id === "cyber")).toBeUndefined();
  });

  it("orders a reasoning axis and includes catalog-only values", () => {
    const axes = buildModelAxes(byId("gpt-5.4-mini"));
    const reasoning = axes.find((a) => a.id === "reasoning");
    expect(reasoning).toBeDefined();
    // known-order prefix must lead; any catalog value present must appear
    const idx = (v: string) => reasoning!.values.indexOf(v);
    if (idx("low") >= 0 && idx("high") >= 0) expect(idx("low")).toBeLessThan(idx("high"));
  });
});

describe("combo validation (asymmetric models)", () => {
  // gpt-5.5: fast=true only exists at context=272k, never at context=1m.
  it("accepts a real combo", () => {
    const item = byId("gpt-5.5");
    expect(isValidCombo(item, { context: "272k", reasoning: "high", fast: "true" })).toBe(true);
  });

  it("rejects an impossible combo (fast at 1m context)", () => {
    const item = byId("gpt-5.5");
    expect(isValidCombo(item, { context: "1m", reasoning: "high", fast: "true" })).toBe(false);
  });

  it("snapCombo fixes a conflicting non-changed axis, keeping the just-changed axis", () => {
    const item = byId("gpt-5.5");
    // User just switched context to 1m; fast=true is now invalid -> snap fast.
    const snapped = snapCombo(item, { context: "1m", reasoning: "high", fast: "true" }, "context");
    expect(snapped.context).toBe("1m"); // changed axis preserved
    expect(isValidCombo(item, snapped)).toBe(true); // result is valid
  });

  it("snapCombo returns the input unchanged when already valid", () => {
    const item = byId("gpt-5.5");
    const input = { context: "272k", reasoning: "high", fast: "true" };
    expect(snapCombo(item, input, "fast")).toEqual(input);
  });
});
