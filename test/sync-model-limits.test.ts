import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseDocsTable,
  matchModelId,
  parseTokens,
  parsePrice,
} from "../scripts/sync-model-limits.mjs";

const legacy = readFileSync(join(__dirname, "fixtures/cursor-legacy-docs.md"), "utf8");
const pricing = readFileSync(join(__dirname, "fixtures/cursor-pricing-docs.md"), "utf8");

describe("parseTokens", () => {
  it("parses k and M suffixes and treats a dash as absent", () => {
    expect(parseTokens("200k")).toBe(200_000);
    expect(parseTokens("300k")).toBe(300_000);
    expect(parseTokens("1M")).toBe(1_000_000);
    expect(parseTokens("-")).toBeUndefined();
  });
});

describe("parsePrice", () => {
  it("parses dollar amounts and treats a dash as zero", () => {
    expect(parsePrice("$3")).toBe(3);
    expect(parsePrice("$0.30")).toBe(0.3);
    expect(parsePrice("$12.5")).toBe(12.5);
    expect(parsePrice("-")).toBe(0);
  });
});

describe("parseDocsTable", () => {
  it("extracts the model name out of a markdown link cell", () => {
    const rows = parseDocsTable(legacy, ["Model", "Default context"]);
    const names = rows.map((r) => r["Model"]);
    expect(names).toContain("Claude 4.6 Sonnet");
    expect(names).toContain("Auto Cost");
  });

  it("selects the table that has the requested columns, not the first table", () => {
    // The pricing doc ships two tables: the model table and an unrelated
    // Plan/Price table. Selecting by column names is what keeps them apart.
    const rows = parseDocsTable(pricing, ["Model", "Input", "Output"]);
    expect(rows.map((r) => r["Model"])).toContain("GPT-5.5");
    expect(rows.map((r) => r["Model"])).not.toContain("**Pro**");
    const plans = parseDocsTable(pricing, ["Plan", "Price"]);
    expect(plans.map((r) => r["Plan"])).toContain("**Pro**");
    expect(plans.map((r) => r["Plan"])).not.toContain("GPT-5.5");
  });

  it("throws when no table carries every requested column", () => {
    expect(() => parseDocsTable(legacy, ["Model", "Nope"])).toThrow(/Nope/);
  });

  it("reads price from the structured columns and ignores promo prose in Notes", () => {
    // Claude Sonnet 5's row advertises a $2/$10 launch promotion in its Notes
    // cell while the price columns still read $3/$15. We parse columns only.
    const rows = parseDocsTable(pricing, ["Model", "Input", "Output", "Notes"]);
    const sonnet5 = rows.find((r) => r["Model"] === "Claude Sonnet 5");
    expect(sonnet5?.["Notes"]).toMatch(/\$2\/M input and \$10\/M output/);
    expect(parsePrice(sonnet5?.["Input"] ?? "")).toBe(3);
    expect(parsePrice(sonnet5?.["Output"] ?? "")).toBe(15);
  });
});

describe("matchModelId", () => {
  const rows = parseDocsTable(legacy, ["Model", "Default context"]);

  it("matches despite flipped word order and vendor prefixes", () => {
    expect(matchModelId("claude-sonnet-4-6", rows)?.row?.["Model"]).toBe("Claude 4.6 Sonnet");
    expect(matchModelId("claude-opus-4-8", rows)?.row?.["Model"]).toBe("Claude Opus 4.8");
    expect(matchModelId("gpt-5.5", rows)?.row?.["Model"]).toBe("GPT-5.5");
    expect(matchModelId("grok-4.5", rows)?.row?.["Model"]).toBe("Grok 4.5");
  });

  it("returns undefined for ids the docs do not list", () => {
    expect(matchModelId("auto-smart", rows)?.row).toBeUndefined();
    expect(matchModelId("default", rows)?.row).toBeUndefined();
    // Docs list only GPT-5.1 Codex / Codex Max / Codex Mini, never bare 5.1.
    expect(matchModelId("gpt-5.1", rows)?.row).toBeUndefined();
  });

  it("does not fall back to a sibling variant row", () => {
    // "Composer 2.5" must not satisfy the id "composer-2".
    expect(matchModelId("composer-2", rows)?.row).toBeUndefined();
    expect(matchModelId("composer-2.5", rows)?.row?.["Model"]).toBe("Composer 2.5");
  });

  it("does not match a model the pricing table omits", () => {
    // The pricing doc is the "Other Models" table; Cursor Models pool models
    // are priced by pool and never appear there.
    const priceRows = parseDocsTable(pricing, ["Model", "Input", "Output"]);
    expect(matchModelId("grok-4.5", priceRows)?.row).toBeUndefined();
  });

  it("reports ambiguity instead of silently picking one row", () => {
    const md = [
      "| Model | Default context |",
      "| --- | --- |",
      "| Claude Sonnet 5 | 200k |",
      "| Claude 5 Sonnet | 300k |",
    ].join("\n");
    const dupes = parseDocsTable(md, ["Model", "Default context"]);
    const result = matchModelId("claude-sonnet-5", dupes);
    expect(result?.row).toBeUndefined();
    expect(result?.ambiguous).toEqual(["Claude Sonnet 5", "Claude 5 Sonnet"]);
  });
});
