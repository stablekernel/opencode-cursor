import { describe, expect, it } from "vitest";
import type { ModelListItem } from "@cursor/sdk";
import { resolveAdvertisedContextLimit } from "../src/model-discovery.js";

function model(partial: Partial<ModelListItem>): ModelListItem {
  return { id: "x", displayName: "X", ...partial } as ModelListItem;
}

const context = (...values: string[]) => ({
  id: "context",
  values: values.map((value) => ({ value })),
});

describe("resolveAdvertisedContextLimit", () => {
  it("returns undefined when the model has no context parameter", () => {
    expect(resolveAdvertisedContextLimit(model({}))).toBeUndefined();
  });

  it("uses the default variant's context preset", () => {
    const m = model({
      parameters: [context("300k", "1m")],
      variants: [
        { displayName: "low", params: [{ id: "context", value: "300k" }] },
        { displayName: "high", isDefault: true, params: [{ id: "context", value: "1m" }] },
      ],
    });
    expect(resolveAdvertisedContextLimit(m)).toBe(1_000_000);
  });

  it("uses the smallest preset when no variant is default", () => {
    expect(resolveAdvertisedContextLimit(model({ parameters: [context("272k", "1m")] }))).toBe(
      272_000,
    );
  });

  it("ignores unparseable values", () => {
    expect(resolveAdvertisedContextLimit(model({ parameters: [context("auto", "300k")] }))).toBe(
      300_000,
    );
  });
});
