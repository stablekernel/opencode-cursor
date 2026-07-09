import { describe, expect, it } from "vitest";
import type { ModelListItem } from "@cursor/sdk";
import catalog from "./fixtures/cursor-catalog.json" with { type: "json" };
import { buildModelAxes } from "../src/model-axes.js";

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
});
