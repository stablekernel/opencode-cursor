import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as sync from "../scripts/sync-model-limits.mjs";
import {
  parseDocsTable,
  matchModelId,
  parseTokens,
  parsePrice,
  normalizeForComparison,
  generate,
} from "../scripts/sync-model-limits.mjs";

const legacy = readFileSync(join(__dirname, "fixtures/cursor-legacy-docs.md"), "utf8");
const pricing = readFileSync(join(__dirname, "fixtures/cursor-pricing-docs.md"), "utf8");

/** Build a minimal GFM table so a single parse/match rule can be isolated. */
function table(header: string[], rows: string[][]): string {
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((cells) => `| ${cells.join(" | ")} |`),
  ].join("\n");
}

/** The model ids emitted into one generated map, in emission order. */
function emittedKeys(text: string, marker: string): string[] {
  const start = text.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = text.indexOf("};", start);
  return [...text.slice(start, end).matchAll(/^ {2}"([^"]+)":/gm)].map((m) => m[1] ?? "");
}

describe("parseTokens", () => {
  it("parses k and M suffixes and treats a dash as absent", () => {
    expect(parseTokens("200k")).toBe(200_000);
    expect(parseTokens("300k")).toBe(300_000);
    expect(parseTokens("1M")).toBe(1_000_000);
    expect(parseTokens("-")).toBeUndefined();
  });

  it("throws on anything it cannot parse, so a docs format change exits 2", () => {
    // Every one of these would otherwise become a plausible-looking number.
    expect(() => parseTokens("200 thousand")).toThrow(/cannot parse a token count/);
    expect(() => parseTokens("~200k")).toThrow(/cannot parse a token count/);
    expect(() => parseTokens("200k (Max Mode)")).toThrow(/cannot parse a token count/);
    expect(() => parseTokens("n/a")).toThrow(/cannot parse a token count/);
  });
});

describe("parsePrice", () => {
  it("parses dollar amounts and treats a dash as zero", () => {
    expect(parsePrice("$3")).toBe(3);
    expect(parsePrice("$0.30")).toBe(0.3);
    expect(parsePrice("$12.5")).toBe(12.5);
    // "-" is Cursor's documented "not applicable" — a real $0.
    expect(parsePrice("-")).toBe(0);
  });

  it("throws on anything it cannot parse, so a docs format change exits 2", () => {
    expect(() => parsePrice("$3/M")).toThrow(/cannot parse a price/);
    expect(() => parsePrice("free")).toThrow(/cannot parse a price/);
    expect(() => parsePrice("$2 (promo)")).toThrow(/cannot parse a price/);
  });

  it("throws on an empty cell rather than answering $0", () => {
    // An empty cell states nothing about price. Answering 0 would put a
    // silently wrong rate-card entry in front of users, which is the exact
    // failure the strict-override rule exists to prevent. Realistic trigger:
    // Cursor writing `| |` instead of `| - |`.
    expect(() => parsePrice("")).toThrow(/empty price cell/);
    expect(() => parsePrice("   ")).toThrow(/empty price cell/);
    expect(() => parsePrice(undefined as unknown as string)).toThrow(/empty price cell/);
  });
});

describe("normalizeForComparison", () => {
  // This is what keeps `--check` from failing every day on the date alone. If
  // it stopped blanking the line, the drift job would cry wolf until someone
  // silenced it; if it blanked too much, real drift would go unreported.
  const file = (dateLine: string, body: string) => `/**\n${dateLine}\n */\nconst x = ${body};\n`;

  it("ignores the date line so the passage of time is not drift", () => {
    const a = file(" * Data last changed: 2026-01-01", "1");
    const b = file(" * Data last changed: 2027-12-31", "1");
    expect(a).not.toBe(b);
    expect(normalizeForComparison(a)).toBe(normalizeForComparison(b));
  });

  it("still reports a difference anywhere else, including on the same date", () => {
    const a = file(" * Data last changed: 2026-01-01", "1");
    const b = file(" * Data last changed: 2026-01-01", "2");
    expect(normalizeForComparison(a)).not.toBe(normalizeForComparison(b));
  });

  it("blanks only the date line, not the lines around it", () => {
    const text = file(" * Data last changed: 2026-01-01", "1");
    const normalized = normalizeForComparison(text);
    expect(normalized).toContain("<ignored for comparison>");
    expect(normalized).not.toContain("2026-01-01");
    expect(normalized).toContain("const x = 1;");
  });

  it("normalizes the real generated file's date line", () => {
    // Guards the coupling between the emitted label and the regex: rename one
    // without the other and `--check` silently starts failing on the date.
    const { text } = generate({ contextMd: legacy, pricingMd: pricing, modelIds: ["gpt-5.5"], overrides: {} });
    expect(text).toMatch(/^ \* Data last changed: \d{4}-\d{2}-\d{2}$/m);
    expect(normalizeForComparison(text)).toContain(" * Data last changed: <ignored for comparison>");
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

  it("throws when a data row is shorter than the header and drops a requested column", () => {
    // A short row used to yield "" for the missing cells, which parsePrice
    // turned into $0 — a wrong rate card with no signal at all.
    const md = table(
      ["Model", "Provider", "Input", "Output"],
      [["Claude Sonnet 5", "Anthropic", "$3", "$15"], ["Claude Opus 5", "Anthropic"]],
    );
    expect(() => parseDocsTable(md, ["Model", "Input", "Output"])).toThrow(
      /Claude Opus 5.*missing the requested column "Input"/,
    );
  });

  it("does not throw for a column it was not asked for", () => {
    // Narrow on purpose: only the columns the caller depends on are contracts.
    const md = table(
      ["Model", "Provider", "Input", "Notes"],
      [["Claude Sonnet 5", "Anthropic", "$3"]],
    );
    const rows = parseDocsTable(md, ["Model", "Input"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["Input"]).toBe("$3");
    expect(rows[0]?.["Notes"]).toBeUndefined();
  });

  it("keeps an empty-but-present cell distinct from an absent one", () => {
    const md = table(["Model", "Provider", "Input"], [["Claude Sonnet 5", "Anthropic", ""]]);
    const rows = parseDocsTable(md, ["Model", "Input"]);
    expect(rows[0]?.["Input"]).toBe("");
    // Present-but-empty parses no further: it is not a $0.
    expect(() => parsePrice(rows[0]?.["Input"] ?? "")).toThrow(/empty price cell/);
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
    const md = table(
      ["Model", "Provider", "Default context"],
      [
        ["Claude Sonnet 5", "Anthropic", "200k"],
        ["Claude 5 Sonnet", "Anthropic", "300k"],
      ],
    );
    const dupes = parseDocsTable(md, ["Model", "Default context"]);
    const result = matchModelId("claude-sonnet-5", dupes);
    expect(result?.row).toBeUndefined();
    expect(result?.ambiguous).toEqual(["Claude Sonnet 5", "Claude 5 Sonnet"]);
  });

  it("refuses the (fast mode) variant row", () => {
    // The 6x-wrong-cost hazard, asserted rather than described: the context
    // table lists "Claude Opus 4.7 (fast mode)" at 200k and the pricing table
    // prices it at $30/$150 against Opus's normal $5/$25. A subset-based
    // matcher would hand that row to `claude-opus-4-7`.
    const priceRows = parseDocsTable(pricing, ["Model", "Input", "Output"]);
    const fast = priceRows.find((r) => r["Model"] === "Claude Opus 4.7 (fast mode)");
    expect(fast?.["Input"]).toBe("$30");
    expect(fast?.["Output"]).toBe("$150");

    expect(rows.map((r) => r["Model"])).toContain("Claude Opus 4.7 (fast mode)");
    // Neither table offers a plain Opus 4.7 row in these fixtures, so the only
    // candidate is the fast-mode row — and it is refused outright, not
    // preferred-but-available.
    expect(matchModelId("claude-opus-4-7", rows)?.row).toBeUndefined();
    expect(matchModelId("claude-opus-4-7", rows)?.ambiguous).toBeUndefined();
    expect(matchModelId("claude-opus-4-7", priceRows)?.row).toBeUndefined();
  });

  it("requires the Provider cell to agree when the id names a stripped vendor", () => {
    // `claude` and `gpt` are dropped from both sides so word order can differ,
    // which also discards vendor identity: `{5.5}` describes both "GPT-5.5"
    // and a hypothetical "Claude 5.5". The Provider column decides.
    const crossVendor = parseDocsTable(
      table(["Model", "Provider", "Default context"], [["Claude 5.5", "Anthropic", "999k"]]),
      ["Model", "Default context"],
    );
    expect(matchModelId("gpt-5.5", crossVendor)?.row).toBeUndefined();
    expect(matchModelId("claude-5.5", crossVendor)?.row?.["Model"]).toBe("Claude 5.5");
  });

  it("picks the right row when two vendors ship the same remaining tokens", () => {
    const bothVendors = parseDocsTable(
      table(
        ["Model", "Provider", "Default context"],
        [
          ["Claude 5.5", "Anthropic", "300k"],
          ["GPT-5.5", "OpenAI", "272k"],
        ],
      ),
      ["Model", "Default context"],
    );
    expect(matchModelId("gpt-5.5", bothVendors)?.row?.["Default context"]).toBe("272k");
    expect(matchModelId("claude-5.5", bothVendors)?.row?.["Default context"]).toBe("300k");
  });

  it("does not match a vendor-bearing id against a row with no Provider cell", () => {
    // Strict on purpose: a blank Provider is not evidence of the right vendor,
    // and matching anyway would be deciding on the evidence just found absent.
    const noProvider = parseDocsTable(
      table(["Model", "Default context"], [["Claude Opus 4.8", "300k"]]),
      ["Model", "Default context"],
    );
    expect(matchModelId("claude-opus-4-8", noProvider)?.row).toBeUndefined();
  });
});

describe("generate", () => {
  // `modelIds` and `overrides` are injected so these contracts run against the
  // 8-row fixtures. Without injection the function closes over the live 33-id
  // catalog and throws on ~25 unrelated ids before reaching the assertion.
  const base = { contextMd: legacy, pricingMd: pricing };

  it("throws when an id has no docs row and no override", () => {
    // The strict-override contract: never a silent 200K, never a silent $0.
    expect(() => generate({ ...base, modelIds: ["totally-made-up-model"], overrides: {} })).toThrow(
      /totally-made-up-model: no "Default context" .* and no OVERRIDES entry/,
    );
  });

  it("throws when an id has a context row but no pricing row and no override", () => {
    // Grok 4.5 is in the context table and absent from the pricing table, so
    // context and cost must be satisfiable independently — and an unsatisfied
    // cost must still stop the run.
    expect(() => generate({ ...base, modelIds: ["grok-4.5"], overrides: {} })).toThrow(
      /grok-4\.5: no pricing row .* and no OVERRIDES entry/,
    );
  });

  it("throws on an ambiguous context match", () => {
    const contextMd = table(
      ["Model", "Provider", "Default context"],
      [
        ["Claude Sonnet 5", "Anthropic", "200k"],
        ["Claude 5 Sonnet", "Anthropic", "300k"],
      ],
    );
    expect(() => generate({ ...base, contextMd, modelIds: ["claude-sonnet-5"], overrides: {} })).toThrow(
      /claude-sonnet-5: ambiguous context match against \[Claude Sonnet 5, Claude 5 Sonnet\]/,
    );
  });

  it("throws on an ambiguous pricing match", () => {
    const pricingMd = table(
      ["Model", "Provider", "Input", "Cache write", "Cache read", "Output"],
      [
        ["GPT-5.5", "OpenAI", "$5", "-", "$0.5", "$30"],
        ["GPT 5.5", "OpenAI", "$50", "-", "$5", "$300"],
      ],
    );
    expect(() => generate({ ...base, pricingMd, modelIds: ["gpt-5.5"], overrides: {} })).toThrow(
      /gpt-5\.5: ambiguous pricing match against \[GPT-5\.5, GPT 5\.5\]/,
    );
  });

  it("prefers the docs row over an override that also covers the id", () => {
    // Precedence matters because an override is invisible to `--check`: it can
    // never drift. A docs row that loses to a stale override is a value that
    // stops being verified without anyone noticing.
    const { text, stats } = generate({
      ...base,
      modelIds: ["claude-opus-4-8"],
      overrides: {
        "claude-opus-4-8": {
          context: 111_000,
          cost: { input: 99, output: 99, cacheRead: 99, cacheWrite: 99 },
          why: "deliberately wrong, to prove the docs win",
        },
      },
    });
    expect(text).toContain(`"claude-opus-4-8": 300_000,`);
    expect(text).not.toContain("111_000");
    expect(text).toContain(`"claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },`);
    expect(text).not.toContain("99");
    expect(stats).toEqual({
      context: { matched: 1, overridden: 0 },
      cost: { matched: 1, overridden: 0 },
    });
  });

  it("falls back to the override only where the docs are silent", () => {
    const { text, stats } = generate({
      ...base,
      modelIds: ["grok-4.5"],
      overrides: { "grok-4.5": { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, why: "pool" } },
    });
    expect(text).toContain(`"grok-4.5": 256_000,`);
    expect(text).toContain(`"grok-4.5": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },`);
    expect(stats).toEqual({
      context: { matched: 1, overridden: 0 },
      cost: { matched: 0, overridden: 1 },
    });
  });

  it("emits keys sorted by model id whatever order they arrive in", () => {
    // Unsorted output would make every `--check` diff unreadable and every
    // reordering look like drift.
    const { text } = generate({
      ...base,
      modelIds: ["gpt-5.5", "claude-opus-4-8", "claude-haiku-4-5"],
      overrides: {},
    });
    const expected = ["claude-haiku-4-5", "claude-opus-4-8", "gpt-5.5"];
    expect(emittedKeys(text, "const MODEL_CONTEXT_LIMITS")).toEqual(expected);
    expect(emittedKeys(text, "const MODEL_COST")).toEqual(expected);
  });

  it("keeps the hand-maintained parts of the template out of the docs-derived maps", () => {
    const { text } = generate({ ...base, modelIds: ["gpt-5.5"], overrides: {} });
    // MODEL_OUTPUT_LIMITS has no docs column behind it and is emitted verbatim.
    expect(emittedKeys(text, "const MODEL_OUTPUT_LIMITS")).toEqual([
      "claude-opus-4-7",
      "claude-opus-4-8",
      "claude-opus-5",
      "claude-fable-5",
      "gpt-5.5",
      "gpt-5.6-sol",
    ]);
    expect(text).toContain("const DEFAULT_CONTEXT_LIMIT = 200_000;");
    expect(text).toContain("const DEFAULT_OUTPUT_LIMIT = 32_000;");
    expect(text).toContain("const DEFAULT_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };");
  });
});

describe("CLI entry", () => {
  const moduleSrc = readFileSync(join(__dirname, "../scripts/sync-model-limits.mjs"), "utf8");
  const cliSrc = readFileSync(join(__dirname, "../scripts/sync-model-limits-cli.mjs"), "utf8");

  it("runs main unconditionally, with no entry-point guard", () => {
    // The guard class this replaces was fail-open: when `argv[1]` did not equal
    // the module URL, `main()` never ran and the process exited 0 having done
    // nothing — a permanently green drift job.
    expect(cliSrc).toMatch(/^process\.exitCode = await main\(process\.argv\.slice\(2\)\);$/m);
    expect(cliSrc).not.toMatch(/if\s*\(/);
  });

  it("keeps the generator module import-pure", () => {
    expect(moduleSrc).not.toMatch(/import\.meta\.url ===/);
    expect(moduleSrc).not.toMatch(/process\.exitCode/);
    expect(moduleSrc).toMatch(/^export async function main\(argv\) \{$/m);
  });

  it("is the file the npm script runs", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["sync:model-limits"]).toBe("node scripts/sync-model-limits-cli.mjs");
  });

  it("exports exactly the names the hand-maintained declaration file lists", () => {
    // `scripts/sync-model-limits.d.mts` is a hand-written mirror; this is what
    // stops it drifting out of existence-agreement with the module.
    expect(Object.keys(sync).sort()).toEqual([
      "MODEL_IDS",
      "OVERRIDES",
      "SOURCES",
      "generate",
      "main",
      "matchModelId",
      "normalizeForComparison",
      "parseDocsTable",
      "parsePrice",
      "parseTokens",
    ]);
  });
});
