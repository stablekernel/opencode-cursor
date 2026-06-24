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

  it("drops the boolean thinking variant when an effort enum is present (claude catalog shape)", () => {
    // Cursor's claude-* catalog exposes BOTH a boolean `thinking` toggle and an
    // effort enum. Selecting any effort level already enables reasoning, so the
    // standalone `thinking` variant is redundant — and surfacing it would add a
    // stray entry the standard opencode providers (effort-only) never show.
    const variants = buildModelVariants(
      model([
        { id: "thinking", values: [{ value: "false" }, { value: "true" }] },
        { id: "effort", values: [{ value: "low" }, { value: "max" }] },
      ]),
    );
    expect(variants).toEqual({
      low: { params: { effort: "low" } },
      max: { params: { effort: "max" } },
    });
  });

  it("suppresses the boolean thinking variant regardless of param order", () => {
    // Order-independence guard for the hasEffortEnum pre-pass: the effort enum
    // declared AFTER the boolean must still suppress it, and vice versa.
    const enumFirst = buildModelVariants(
      model([
        { id: "effort", values: [{ value: "low" }, { value: "max" }] },
        { id: "thinking", values: [{ value: "false" }, { value: "true" }] },
      ]),
    );
    expect(enumFirst).toEqual({
      low: { params: { effort: "low" } },
      max: { params: { effort: "max" } },
    });
  });

  it("composes suppression with fast defaults (production claude-via-Cursor shape)", () => {
    // The real catalog model: boolean `thinking` + effort enum + `fast`. The
    // `thinking` variant is suppressed, each effort variant bakes `fast` OFF
    // (defaultModelParams), and a standalone `fast` opt-in still surfaces.
    const variants = buildModelVariants(
      model([
        { id: "thinking", values: [{ value: "false" }, { value: "true" }] },
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

  it("does not suppress the boolean thinking variant for a zero-value effort enum", () => {
    // hasEffortEnum requires a non-empty enum; an effort param with no values
    // must not count as an enum, so the boolean `thinking` variant survives.
    const variants = buildModelVariants(
      model([
        { id: "thinking", values: [{ value: "false" }, { value: "true" }] },
        { id: "effort", values: [] },
      ]),
    );
    expect(variants).toEqual({ thinking: { params: { thinking: "true" } } });
  });

  it("does not emit a thinking variant when the boolean lacks a 'true' value", () => {
    // Boolean `thinking=["false"]` has nothing to opt INTO; combined with an
    // effort enum the result is purely the effort variants.
    const variants = buildModelVariants(
      model([
        { id: "thinking", values: [{ value: "false" }] },
        { id: "effort", values: [{ value: "low" }] },
      ]),
    );
    expect(variants).toEqual({ low: { params: { effort: "low" } } });
  });

  it("pins current behavior for a mixed boolean+enum reasoning param", () => {
    // A single reasoning param mixing boolean sentinels with effort values is
    // classified non-boolean (isBooleanParam requires EVERY value be a sentinel),
    // so it flows through the enum branch and emits literal false/true variants.
    // Not a real catalog shape today; pinned so a future change is caught.
    const variants = buildModelVariants(
      model([
        { id: "reasoning", values: [{ value: "false" }, { value: "true" }, { value: "high" }] },
      ]),
    );
    expect(variants).toEqual({
      false: { params: { reasoning: "false" } },
      true: { params: { reasoning: "true" } },
      high: { params: { reasoning: "high" } },
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

  it("renames extra-high to xhigh in the variant key but keeps the wire value", () => {
    // Cursor labels the top reasoning tier "extra-high"; the opencode standard
    // (models.dev) calls it "xhigh". The variant KEY normalizes to xhigh so
    // the cycler is consistent across providers; the param VALUE sent to
    // Cursor's API stays "extra-high".
    const variants = buildModelVariants(
      model([{ id: "reasoning", values: [{ value: "low" }, { value: "extra-high" }] }]),
    );
    expect(variants).toEqual({
      low: { params: { reasoning: "low" } },
      xhigh: { params: { reasoning: "extra-high" } },
    });
  });

  it("drops the 'none' reasoning value (it is the model default)", () => {
    // `none` = reasoning OFF, which is what you get by selecting no variant.
    // Surfacing it as a selectable entry is meaningless, so it is skipped.
    const variants = buildModelVariants(
      model([
        { id: "reasoning", values: [{ value: "none" }, { value: "low" }, { value: "high" }] },
      ]),
    );
    expect(variants).toEqual({
      low: { params: { reasoning: "low" } },
      high: { params: { reasoning: "high" } },
    });
  });

  it("composes none-drop and extra-high rename for the real GPT shape", () => {
    // gpt-5.5 / gpt-5.4 catalog: reasoning=[none,low,medium,high,extra-high]
    // + fast. Expect: low, medium, high, xhigh (no none, extra-high→xhigh),
    // each effort variant bakes fast OFF, plus a standalone fast opt-in.
    const variants = buildModelVariants(
      model([
        {
          id: "reasoning",
          values: [
            { value: "none" },
            { value: "low" },
            { value: "medium" },
            { value: "high" },
            { value: "extra-high" },
          ],
        },
        { id: "fast", values: [{ value: "false" }, { value: "true" }] },
      ]),
    );
    expect(variants).toEqual({
      low: { params: { reasoning: "low", fast: "false" } },
      medium: { params: { reasoning: "medium", fast: "false" } },
      high: { params: { reasoning: "high", fast: "false" } },
      xhigh: { params: { reasoning: "extra-high", fast: "false" } },
      fast: { params: { fast: "true" } },
    });
  });

  it("prefixes the display key on a collision involving extra-high", () => {
    // Defensive: if two reasoning params both resolve to the xhigh display key
    // (one via the real "xhigh" value, one via "extra-high"→xhigh), the second
    // is prefixed with its param id. No current catalog model hits this, but
    // the guard must hold.
    const variants = buildModelVariants(
      model([
        { id: "effort", values: [{ value: "xhigh" }] },
        { id: "reasoning", values: [{ value: "extra-high" }] },
      ]),
    );
    expect(variants).toEqual({
      xhigh: { params: { effort: "xhigh" } },
      "reasoning-xhigh": { params: { reasoning: "extra-high" } },
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
