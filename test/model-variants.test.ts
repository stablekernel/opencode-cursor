import { describe, expect, it } from "vitest";
import type { ModelListItem } from "@cursor/sdk";
import { buildModelVariants, defaultModelParams } from "../src/model-variants.js";
import catalog from "./fixtures/cursor-catalog.json" with { type: "json" };

const cat = catalog as ModelListItem[];
function byId(id: string): ModelListItem {
  const m = cat.find((x) => x.id === id);
  if (!m) throw new Error(`fixture missing model ${id}`);
  return m;
}

describe("buildModelVariants (curated, non-cartesian)", () => {
  it("curates a 40-variant model into a short single-axis list", () => {
    const variants = buildModelVariants(byId("claude-opus-4-8"));
    expect(Object.keys(variants).sort()).toEqual(
      ["300k", "fast", "low", "max", "medium", "xhigh"].sort(),
    );
    // effort values vary effort only; other axes stay at model defaults.
    expect(variants["low"]).toEqual({
      params: { thinking: "true", context: "1m", effort: "low", fast: "false" },
    });
    // the fast opt-in bakes the effort/context/thinking defaults.
    expect(variants["fast"]).toEqual({
      params: { thinking: "true", context: "1m", effort: "high", fast: "true" },
    });
    // the non-default context value is offered too.
    expect(variants["300k"]).toEqual({
      params: { thinking: "true", context: "300k", effort: "high", fast: "false" },
    });
  });

  it("varies effort and bakes the model's default fast (grok fast defaults ON)", () => {
    expect(buildModelVariants(byId("grok-4.5"))).toEqual({
      low: { params: { effort: "low", fast: "true" } },
      medium: { params: { effort: "medium", fast: "true" } },
    });
  });

  it("keys a reasoning axis by value, dropping the default (medium)", () => {
    expect(buildModelVariants(byId("gpt-5.4-mini"))).toEqual({
      none: { params: { reasoning: "none" } },
      low: { params: { reasoning: "low" } },
      high: { params: { reasoning: "high" } },
      xhigh: { params: { reasoning: "xhigh" } },
    });
  });

  it("returns no variants for a model with no axes", () => {
    expect(buildModelVariants(byId("gemini-3.1-pro"))).toEqual({});
  });

  it("returns no variants for a single default-ON toggle (composer fast defaults true)", () => {
    // Known --pure fallback limitation: nothing non-default/non-off to add.
    expect(buildModelVariants(byId("composer-2.5"))).toEqual({});
  });

  it("renames the extra-high reasoning wire value to the xhigh key", () => {
    const variants = buildModelVariants(byId("gpt-5.5"));
    // key is normalized to xhigh; the Cursor wire value stays extra-high.
    expect(variants["xhigh"]).toEqual({
      params: { context: "1m", reasoning: "extra-high", fast: "false" },
    });
  });
});

describe("defaultModelParams (axis defaults + pinned)", () => {
  it("seeds every axis default plus pinned single-value params (opus pins cyber=false)", () => {
    expect(defaultModelParams(byId("claude-opus-4-8"))).toEqual({
      thinking: "true",
      context: "1m",
      effort: "high",
      fast: "false",
      cyber: "false",
    });
  });

  it("uses the model's own default toggle direction (grok fast defaults ON)", () => {
    expect(defaultModelParams(byId("grok-4.5"))).toEqual({ effort: "high", fast: "true" });
  });

  it("returns empty for a model with no axes or pinned params", () => {
    expect(defaultModelParams(byId("gemini-3.1-pro"))).toEqual({});
  });
});
