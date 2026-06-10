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
