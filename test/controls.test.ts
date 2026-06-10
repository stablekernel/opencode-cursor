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
});

// buildModelVariants behavior is covered in test/model-variants.test.ts.
