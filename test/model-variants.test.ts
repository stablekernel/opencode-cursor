import { describe, expect, it } from "vitest";
import type { ModelListItem } from "@cursor/sdk";
import { buildModelVariants } from "../src/model-variants.js";

function model(parameters: ModelListItem["parameters"]): ModelListItem {
  return { id: "m", displayName: "M", parameters };
}

describe("buildModelVariants", () => {
  it("collapses a boolean thinking param into a single param-named variant", () => {
    // Real catalog shape: thinking=["false","true"] (claude-* models). A
    // literal "true"/"false" variant pair is meaningless in the picker.
    const variants = buildModelVariants(
      model([{ id: "thinking", values: [{ value: "false" }, { value: "true" }] }]),
    );
    expect(variants).toEqual({ thinking: { params: { thinking: "true" } } });
  });

  it("keys enum reasoning params by their values", () => {
    // Real catalog shape: reasoning=["none","low","medium","high","extra-high"].
    const variants = buildModelVariants(
      model([{ id: "reasoning", values: [{ value: "low" }, { value: "high" }] }]),
    );
    expect(variants).toEqual({
      low: { params: { reasoning: "low" } },
      high: { params: { reasoning: "high" } },
    });
  });

  it("combines boolean thinking with enum effort (claude catalog shape)", () => {
    const variants = buildModelVariants(
      model([
        { id: "thinking", values: [{ value: "false" }, { value: "true" }] },
        { id: "effort", values: [{ value: "low" }, { value: "max" }] },
      ]),
    );
    expect(variants).toEqual({
      thinking: { params: { thinking: "true" } },
      low: { params: { effort: "low" } },
      max: { params: { effort: "max" } },
    });
  });

  it("prefixes a value key on collision between two enum params", () => {
    const variants = buildModelVariants(
      model([
        { id: "reasoning", values: [{ value: "low" }] },
        { id: "effort", values: [{ value: "low" }] },
      ]),
    );
    expect(variants).toEqual({
      low: { params: { reasoning: "low" } },
      "effort-low": { params: { effort: "low" } },
    });
  });

  it("ignores non-reasoning params and offers no plan variant", () => {
    // fast/context are not reasoning levels; plan is opencode's plan AGENT
    // (Tab), mapped via the chat.params hook — not a model variant.
    const variants = buildModelVariants(
      model([
        { id: "fast", values: [{ value: "false" }, { value: "true" }] },
        { id: "context", values: [{ value: "300k" }, { value: "1m" }] },
      ]),
    );
    expect(variants).toEqual({});
  });

  it("returns no variants for a model without parameters", () => {
    expect(buildModelVariants(model(undefined))).toEqual({});
  });
});
