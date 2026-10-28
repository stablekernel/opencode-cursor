import { describe, expect, it } from "vitest";
import type { ModelListItem } from "@cursor/sdk";
import { resolveControls } from "../src/provider/controls.js";
import { buildModelVariants } from "../src/model-variants.js";

describe("resolveControls", () => {
  it("defaults to static mode and no params", () => {
    const r = resolveControls("composer-2.5", { mode: "agent" }, undefined);
    expect(r.mode).toBe("agent");
    expect(r.modelSelection).toEqual({ id: "composer-2.5" });
  });

  it("lets providerOptions override mode (plan)", () => {
    const r = resolveControls("composer-2.5", { mode: "agent" }, { mode: "plan" });
    expect(r.mode).toBe("plan");
  });

  it("ignores an invalid mode value", () => {
    const r = resolveControls("m", { mode: "agent" }, { mode: "nonsense" });
    expect(r.mode).toBe("agent");
  });

  it("merges static params with per-request params (request wins)", () => {
    const r = resolveControls("m", { mode: "agent", params: { thinking: "low", foo: "a" } }, {
      params: { thinking: "high" },
    });
    expect(r.modelSelection.params).toEqual([
      { id: "thinking", value: "high" },
      { id: "foo", value: "a" },
    ]);
  });

  it("maps the `thinking` convenience key to a thinking param", () => {
    const r = resolveControls("m", { mode: "agent" }, { thinking: "max" });
    expect(r.modelSelection.params).toEqual([{ id: "thinking", value: "max" }]);
  });

  it("coerces non-string param values to strings", () => {
    const r = resolveControls("m", { mode: "agent" }, { params: { budget: 1024 } });
    expect(r.modelSelection.params).toEqual([{ id: "budget", value: "1024" }]);
  });

  it("applies per-model defaults as a floor when no params are supplied", () => {
    // The subagent path: opencode hands the bare model id with no params, so the
    // model's default `fast: "false"` must still be sent (otherwise Cursor's
    // server-side `fast: true` default silently applies).
    const r = resolveControls(
      "composer-2.5",
      { mode: "agent", defaults: { fast: "false" } },
      undefined,
    );
    expect(r.modelSelection.params).toEqual([{ id: "fast", value: "false" }]);
  });

  it("lets a per-request param override the default floor (fast opt-in)", () => {
    const r = resolveControls(
      "composer-2.5",
      { mode: "agent", defaults: { fast: "false" } },
      { params: { fast: "true" } },
    );
    expect(r.modelSelection.params).toEqual([{ id: "fast", value: "true" }]);
  });

  it("lets static params override the default floor", () => {
    const r = resolveControls(
      "m",
      { mode: "agent", defaults: { fast: "false" }, params: { fast: "true" } },
      undefined,
    );
    expect(r.modelSelection.params).toEqual([{ id: "fast", value: "true" }]);
  });
});

type Params = NonNullable<ModelListItem["parameters"]>;
const param = (id: string, values: string[]) => ({
  id,
  displayName: id,
  values: values.map((value) => ({ value })),
});
const GROK_4_6: Params = [
  param("effort", ["low", "medium", "high", "xhigh"]),
  param("fast", ["false", "true"]),
];
const CLAUDE: Params = [param("thinking", ["false", "true"]), param("effort", ["low", "medium", "high", "max"])];
const GPT: Params = [param("reasoning", ["low", "medium", "high", "extra-high"])];

describe("resolveControls `thinking` on models without a matching thinking param (#119)", () => {
  it("moves a configured params.thinking level to the model's effort param", () => {
    const r = resolveControls(
      "grok-4.6",
      { mode: "agent", parameters: GROK_4_6 },
      { params: { thinking: "medium", fast: "false" } },
    );
    expect(r.modelSelection.params).toEqual([
      { id: "fast", value: "false" },
      { id: "effort", value: "medium" },
    ]);
    expect(r.warnings).toEqual([
      expect.stringContaining("grok-4.6 has no `thinking` param; sent `effort: medium` instead"),
    ]);
  });

  it("moves the `thinking` convenience key too", () => {
    const r = resolveControls("grok-4.6", { mode: "agent", parameters: GROK_4_6 }, { thinking: "high" });
    expect(r.modelSelection.params).toEqual([{ id: "effort", value: "high" }]);
  });

  it("keeps a valid boolean thinking value on a model that has the param", () => {
    const r = resolveControls("claude", { mode: "agent", parameters: CLAUDE }, { params: { thinking: "true" } });
    expect(r.modelSelection.params).toEqual([{ id: "thinking", value: "true" }]);
    expect(r.warnings).toEqual([]);
  });

  it("moves a level value off a boolean thinking param onto the effort enum", () => {
    const r = resolveControls("claude", { mode: "agent", parameters: CLAUDE }, { params: { thinking: "max" } });
    expect(r.modelSelection.params).toEqual([{ id: "effort", value: "max" }]);
  });

  it("lets an explicit effort win and drops the unusable thinking key", () => {
    const r = resolveControls(
      "grok-4.6",
      { mode: "agent", parameters: GROK_4_6 },
      { params: { thinking: "medium", effort: "low" } },
    );
    expect(r.modelSelection.params).toEqual([{ id: "effort", value: "low" }]);
    expect(r.warnings).toEqual([expect.stringContaining("ignored `thinking: medium`")]);
  });

  it("maps xhigh to Cursor's extra-high wire value", () => {
    const r = resolveControls("gpt", { mode: "agent", parameters: GPT }, { params: { thinking: "xhigh" } });
    expect(r.modelSelection.params).toEqual([{ id: "reasoning", value: "extra-high" }]);
  });

  it("leaves an unmappable value in place and warns with the accepted values", () => {
    const r = resolveControls("grok-4.6", { mode: "agent", parameters: GROK_4_6 }, { params: { thinking: "max" } });
    expect(r.modelSelection.params).toEqual([{ id: "thinking", value: "max" }]);
    expect(r.warnings).toEqual([expect.stringContaining("effort=low|medium|high|xhigh")]);
  });

  it("changes nothing when the model's parameters are unknown", () => {
    const r = resolveControls("grok-4.6", { mode: "agent" }, { params: { thinking: "medium" } });
    expect(r.modelSelection.params).toEqual([{ id: "thinking", value: "medium" }]);
    expect(r.warnings).toEqual([]);
  });
});

// buildModelVariants behavior is covered in test/model-variants.test.ts.
