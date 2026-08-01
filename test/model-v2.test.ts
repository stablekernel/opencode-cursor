import { describe, expect, it } from "vitest";
import type { ModelListItem } from "@cursor/sdk";
import { buildModelV2Map } from "../src/plugin/model-v2.js";

describe("buildModelV2Map", () => {
  it("seeds the fast-off default into options and exposes a fast opt-in variant", () => {
    const map = buildModelV2Map([
      {
        id: "composer-2.5",
        displayName: "Composer 2.5",
        parameters: [{ id: "fast", values: [{ value: "false" }, { value: "true" }] }],
      } satisfies ModelListItem,
    ]);
    expect(map["composer-2.5"]!.options).toEqual({ params: { fast: "false" } });
    expect(map["composer-2.5"]!.variants).toEqual({ fast: { params: { fast: "true" } } });
  });

  it("leaves options empty for models without non-reasoning booleans", () => {
    const map = buildModelV2Map([{ id: "plain", displayName: "Plain" }]);
    expect(map["plain"]!.options).toEqual({});
  });

  it("sets context limit from per-model map for known models", () => {
    const map = buildModelV2Map([
      { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6" },
      { id: "claude-opus-4-8", displayName: "Claude Opus 4.8" },
      { id: "gpt-5.5", displayName: "GPT-5.5" },
      { id: "grok-4.5", displayName: "Grok 4.5" },
    ]);
    expect(map["claude-sonnet-4-6"]!.limit.context).toBe(200_000);
    expect(map["claude-opus-4-8"]!.limit.context).toBe(300_000);
    expect(map["gpt-5.5"]!.limit.context).toBe(272_000);
    expect(map["grok-4.5"]!.limit.context).toBe(256_000);
  });

  it("falls back to 200K context for unknown models", () => {
    const map = buildModelV2Map([{ id: "some-unknown-model", displayName: "Unknown" }]);
    expect(map["some-unknown-model"]!.limit.context).toBe(200_000);
  });

  it("uses longest prefix match for context limit", () => {
    const map = buildModelV2Map([
      { id: "claude-opus-4-5", displayName: "Opus 4.5" },
      { id: "claude-opus-4-8", displayName: "Opus 4.8" },
    ]);
    expect(map["claude-opus-4-5"]!.limit.context).toBe(200_000);
    expect(map["claude-opus-4-8"]!.limit.context).toBe(300_000);
  });

  it("sets cost from per-model map for known models", () => {
    const map = buildModelV2Map([
      { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6" },
      { id: "claude-opus-4-8", displayName: "Claude Opus 4.8" },
      { id: "gpt-5.5", displayName: "GPT-5.5" },
      { id: "claude-fable-5", displayName: "Claude Fable 5" },
    ]);
    expect(map["claude-sonnet-4-6"]!.cost).toEqual({
      input: 3,
      output: 15,
      cache: { read: 0.3, write: 3.75 },
    });
    expect(map["claude-opus-4-8"]!.cost).toEqual({
      input: 5,
      output: 25,
      cache: { read: 0.5, write: 6.25 },
    });
    expect(map["gpt-5.5"]!.cost).toEqual({
      input: 5,
      output: 30,
      cache: { read: 0.5, write: 0 },
    });
    expect(map["claude-fable-5"]!.cost).toEqual({
      input: 10,
      output: 50,
      cache: { read: 1, write: 12.5 },
    });
  });

  it("sets output limit from per-model map for known models", () => {
    const map = buildModelV2Map([
      { id: "claude-opus-5", displayName: "Claude Opus 5" },
      { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6" },
      { id: "gpt-5.5", displayName: "GPT-5.5" },
      { id: "composer-2.5", displayName: "Composer 2.5" },
    ]);
    expect(map["claude-opus-5"]!.limit.output).toBe(64_000);
    expect(map["claude-sonnet-4-6"]!.limit.output).toBe(32_000);
    expect(map["gpt-5.5"]!.limit.output).toBe(64_000);
    expect(map["composer-2.5"]!.limit.output).toBe(32_000);
  });

  it("uses $0 cost for Cursor Models pool models", () => {
    const map = buildModelV2Map([
      { id: "composer-2.5", displayName: "Composer 2.5" },
      { id: "grok-4.5", displayName: "Grok 4.5" },
      { id: "auto-smart", displayName: "Auto Smart" },
    ]);
    expect(map["composer-2.5"]!.cost).toEqual({
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    });
    expect(map["grok-4.5"]!.cost).toEqual({
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    });
    expect(map["auto-smart"]!.cost).toEqual({
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    });
  });

  it("falls back to $0 cost for unknown models", () => {
    const map = buildModelV2Map([{ id: "some-unknown-model", displayName: "Unknown" }]);
    expect(map["some-unknown-model"]!.cost).toEqual({
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    });
  });

  it("uses longest prefix match for cost", () => {
    // gpt-5.4 (2.50) vs gpt-5.4-mini (0.75) must pick the longer prefix
    const map = buildModelV2Map([
      { id: "gpt-5.4", displayName: "GPT-5.4" },
      { id: "gpt-5.4-mini", displayName: "GPT-5.4 Mini" },
      { id: "gpt-5.4-nano", displayName: "GPT-5.4 Nano" },
    ]);
    expect(map["gpt-5.4"]!.cost.input).toBe(2.5);
    expect(map["gpt-5.4-mini"]!.cost.input).toBe(0.75);
    expect(map["gpt-5.4-nano"]!.cost.input).toBe(0.2);
  });
});
