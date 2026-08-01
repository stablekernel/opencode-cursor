import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelListItem } from "@cursor/sdk";

const readLatestModelCache = vi.fn<() => ModelListItem[] | undefined>(() => undefined);
vi.mock("../src/model-cache.js", () => ({
  readModelCache: () => undefined,
  writeModelCache: () => {},
  readLatestModelCache: () => readLatestModelCache(),
}));

const { discoverModels, modelSupportsReasoning, toOpencodeModels } = await import(
  "../src/model-discovery.js"
);

afterEach(() => readLatestModelCache.mockReset());

const items: ModelListItem[] = [
  {
    id: "composer-2.5",
    displayName: "Composer 2.5",
    parameters: [{ id: "thinking", values: [{ value: "off" }, { value: "on" }] }],
  },
  { id: "plain", displayName: "Plain Model" },
];

describe("modelSupportsReasoning", () => {
  it("detects a thinking/reasoning parameter", () => {
    expect(modelSupportsReasoning(items[0]!)).toBe(true);
    expect(modelSupportsReasoning(items[1]!)).toBe(false);
  });
});

describe("toOpencodeModels", () => {
  it("maps to opencode provider model config entries", () => {
    const map = toOpencodeModels(items);
    expect(Object.keys(map)).toEqual(["composer-2.5", "plain"]);
    expect(map["composer-2.5"]).toMatchObject({
      id: "composer-2.5",
      name: "Composer 2.5",
      reasoning: true,
      tool_call: true,
      temperature: false,
      attachment: true,
    });
    expect(map["plain"]!.reasoning).toBe(false);
  });

  it("falls back to id when displayName missing", () => {
    const map = toOpencodeModels([{ id: "x", displayName: "" }]);
    expect(map["x"]!.name).toBe("x");
  });

  it("seeds variants so opencode's picker exposes thinking levels and plan mode", () => {
    // opencode discards the provider.models() hook for providers outside the
    // models.dev catalog, so the config-seeded models map is the ONLY place
    // variants can come from — they must be present here.
    const map = toOpencodeModels(items);
    expect(map["composer-2.5"]!.variants).toEqual({
      off: { params: { thinking: "off" } },
      on: { params: { thinking: "on" } },
    });
    // No reasoning params → no variants (plan is an opencode agent, not a variant).
    expect(map["plain"]!.variants).toEqual({});
  });

  it("seeds the fast-off default into a fast-capable model's options.params", () => {
    // The config-seeded models map is the only channel through which per-model
    // defaults reach opencode, so a fast-capable model must default `fast` OFF
    // here (sent on every turn unless the user picks the `fast` variant).
    const map = toOpencodeModels([
      {
        id: "composer-2.5",
        displayName: "Composer 2.5",
        parameters: [{ id: "fast", values: [{ value: "false" }, { value: "true" }] }],
      },
      { id: "plain", displayName: "Plain Model" },
    ]);
    expect(map["composer-2.5"]!.options).toEqual({ params: { fast: "false" } });
    expect(map["composer-2.5"]!.variants).toEqual({ fast: { params: { fast: "true" } } });
    expect(map["plain"]!.options).toEqual({});
  });
});

describe("toOpencodeModels config-channel limits and cost", () => {
  it("emits per-model limit with both context and output", () => {
    const out = toOpencodeModels([
      { id: "claude-opus-4-8", displayName: "Opus 4.8" },
      { id: "gpt-5.5", displayName: "GPT-5.5" },
      { id: "grok-4.5", displayName: "Grok 4.5" },
    ] satisfies ModelListItem[]);
    expect(out["claude-opus-4-8"]!.limit).toEqual({ context: 300_000, output: 64_000 });
    expect(out["gpt-5.5"]!.limit).toEqual({ context: 272_000, output: 64_000 });
    expect(out["grok-4.5"]!.limit).toEqual({ context: 256_000, output: 32_000 });
  });

  it("emits cost with FLAT snake_case cache keys, not nested cache object", () => {
    const out = toOpencodeModels([
      { id: "claude-sonnet-4-6", displayName: "Sonnet 4.6" },
    ] satisfies ModelListItem[]);
    expect(out["claude-sonnet-4-6"]!.cost).toEqual({
      input: 3,
      output: 15,
      cache_read: 0.3,
      cache_write: 3.75,
    });
    expect(out["claude-sonnet-4-6"]!.cost).not.toHaveProperty("cache");
  });

  it("emits $0 cost for Cursor Models pool models", () => {
    const out = toOpencodeModels([
      { id: "composer-2.5", displayName: "Composer 2.5" },
    ] satisfies ModelListItem[]);
    expect(out["composer-2.5"]!.cost).toEqual({
      input: 0,
      output: 0,
      cache_read: 0,
      cache_write: 0,
    });
  });

  it("falls back to 200K/32K and $0 for unknown models", () => {
    const out = toOpencodeModels([
      { id: "brand-new-model", displayName: "New" },
    ] satisfies ModelListItem[]);
    expect(out["brand-new-model"]!.limit).toEqual({ context: 200_000, output: 32_000 });
    expect(out["brand-new-model"]!.cost).toEqual({
      input: 0,
      output: 0,
      cache_read: 0,
      cache_write: 0,
    });
  });
});

describe("discoverModels without a key", () => {
  it("returns the fallback snapshot with a warning when no cache exists", async () => {
    const prev = process.env.CURSOR_API_KEY;
    delete process.env.CURSOR_API_KEY;
    readLatestModelCache.mockReturnValue(undefined);
    try {
      const result = await discoverModels({});
      expect(result.source).toBe("fallback");
      expect(result.models.length).toBeGreaterThan(0);
      expect(result.warning).toMatch(/API key/i);
    } finally {
      if (prev !== undefined) process.env.CURSOR_API_KEY = prev;
    }
  });

  it("seeds from the latest catalog cache when present (keyless config hook)", async () => {
    const prev = process.env.CURSOR_API_KEY;
    delete process.env.CURSOR_API_KEY;
    readLatestModelCache.mockReturnValue([{ id: "gpt-5.5", displayName: "GPT-5.5" }]);
    try {
      const result = await discoverModels({});
      expect(result.source).toBe("cache");
      expect(result.models.map((m) => m.id)).toEqual(["gpt-5.5"]);
      expect(result.warning).toBeUndefined();
    } finally {
      if (prev !== undefined) process.env.CURSOR_API_KEY = prev;
    }
  });
});
