import { describe, expect, it } from "vitest";
import type { ModelListItem } from "@cursor/sdk";
import { buildModelVariants, defaultModelParams } from "../src/model-variants.js";

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

  it("surfaces a non-reasoning boolean (fast) as an opt-in toggle; ignores enum context", () => {
    // `fast` is Cursor's fast-tier toggle. It is not a reasoning level, but the
    // user must be able to opt INTO it from the picker (default is off, sent
    // explicitly via defaultModelParams). `context` is an enum, still unsupported.
    // plan is opencode's plan AGENT (Tab), mapped via the chat.params hook.
    const variants = buildModelVariants(
      model([
        { id: "fast", values: [{ value: "false" }, { value: "true" }] },
        { id: "context", values: [{ value: "300k" }, { value: "1m" }] },
      ]),
    );
    expect(variants).toEqual({ fast: { params: { fast: "true" } } });
  });

  it("bakes the fast-off default into reasoning variants for fast-capable models", () => {
    // Cursor defaults `fast` to true for several models (composer/codex). When
    // the user picks a reasoning level we must pin fast OFF explicitly, so a
    // reasoning selection never silently falls back to Cursor's fast default.
    const variants = buildModelVariants(
      model([
        { id: "effort", values: [{ value: "low" }, { value: "high" }] },
        { id: "fast", values: [{ value: "false" }, { value: "true" }] },
      ]),
    );
    expect(variants).toEqual({
      low: { params: { effort: "low", fast: "false" } },
      high: { params: { effort: "high", fast: "false" } },
      fast: { params: { fast: "true" } },
    });
  });

  it("returns no variants for a model without parameters", () => {
    expect(buildModelVariants(model(undefined))).toEqual({});
  });
});

describe("defaultModelParams", () => {
  it("defaults non-reasoning boolean params (fast) OFF", () => {
    expect(
      defaultModelParams(
        model([{ id: "fast", values: [{ value: "false" }, { value: "true" }] }]),
      ),
    ).toEqual({ fast: "false" });
  });

  it("returns no defaults for models without non-reasoning booleans", () => {
    expect(
      defaultModelParams(
        model([{ id: "effort", values: [{ value: "low" }, { value: "high" }] }]),
      ),
    ).toEqual({});
    expect(defaultModelParams(model(undefined))).toEqual({});
  });
});
