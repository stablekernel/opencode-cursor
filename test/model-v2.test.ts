import { describe, expect, it } from "vitest";
import type { ModelListItem } from "@cursor/sdk";
import { buildModelV2Map } from "../src/plugin/model-v2.js";

describe("buildModelV2Map", () => {
  it("seeds the fast-off default into options and exposes a fast opt-in variant", () => {
    const map = buildModelV2Map([
      {
        id: "composer-2.5",
        displayName: "Composer 2.5",
        variants: [
          { params: [{ id: "fast", value: "false" }], displayName: "d", isDefault: true },
          { params: [{ id: "fast", value: "true" }], displayName: "d" },
        ],
      } satisfies ModelListItem,
    ]);
    expect(map["composer-2.5"]!.options).toEqual({ params: { fast: "false" } });
    expect(map["composer-2.5"]!.variants).toEqual({ fast: { params: { fast: "true" } } });
  });

  it("leaves options empty for models without non-reasoning booleans", () => {
    const map = buildModelV2Map([{ id: "plain", displayName: "Plain" }]);
    expect(map["plain"]!.options).toEqual({});
  });
});
