import { describe, expect, it } from "vitest";
import { MODEL_IDS } from "../scripts/sync-model-limits.mjs";
import { resolveContextLimit, resolveCost } from "../src/model-limits.js";
import liveIds from "./fixtures/cursor-model-ids.json" with { type: "json" };

/**
 * Every id the live catalog returned must be listed in MODEL_IDS, or it gets
 * the 200K/$0 defaults and the generated maps silently lag a release. The
 * fixture is a snapshot: add new catalog ids to MODEL_IDS with the sync script,
 * then refresh the fixture.
 */
describe("model-limit coverage of the live catalog", () => {
  it.each(liveIds)("%s is covered by MODEL_IDS", (id) => {
    expect(MODEL_IDS).toContain(id);
  });

  it("uses the docs values for ids the catalog spells differently", () => {
    expect(resolveContextLimit("deepseek-v41-flash-1017")).toBe(1_000_000);
    expect(resolveCost("glm-5p3-flash")).toMatchObject({ input: 0.15, output: 0.5 });
  });
});
