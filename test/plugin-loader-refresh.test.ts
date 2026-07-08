import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Spy on model discovery so we can assert HOW the auth loader warms the cache.
// The loader runs once per opencode startup with the resolved key; to surface
// newly released Cursor models it must force a live re-fetch rather than
// respecting the (possibly still-fresh) 24h on-disk cache.
const discoverModels = vi.fn(
  async (_options: { apiKey?: string; forceRefresh?: boolean } = {}) => ({
    models: [] as unknown[],
    source: "live" as const,
  }),
);
vi.mock("../src/model-discovery.js", () => ({
  discoverModels,
  toOpencodeModels: () => ({}),
}));

const { default: plugin } = await import("../src/plugin/index.js");

let savedEnvKey: string | undefined;

beforeEach(() => {
  savedEnvKey = process.env.CURSOR_API_KEY;
  delete process.env.CURSOR_API_KEY;
});

afterEach(() => {
  if (savedEnvKey === undefined) delete process.env.CURSOR_API_KEY;
  else process.env.CURSOR_API_KEY = savedEnvKey;
  discoverModels.mockClear();
});

describe("CursorPlugin auth loader model refresh", () => {
  it("force-refreshes the model catalog on startup so new models appear", async () => {
    const hooks = await plugin({ directory: "/work" } as never);

    const loaded = await hooks.auth!.loader!(
      async () => ({ type: "api", key: "sekret" }) as never,
      { provider: "cursor" } as never,
    );
    expect(loaded).toEqual({ apiKey: "sekret" });

    // The warm call must bypass the cache: without forceRefresh a fresh 24h
    // cache short-circuits discovery and newly released models never surface.
    const warmCall = discoverModels.mock.calls.find(
      (c) => c[0]?.apiKey === "sekret",
    );
    expect(warmCall, "loader should warm discovery with the resolved key").toBeDefined();
    expect(warmCall![0]?.forceRefresh).toBe(true);
  });

  it("does not attempt discovery when no key is resolved", async () => {
    const hooks = await plugin({ directory: "/work" } as never);
    await hooks.auth!.loader!(async () => undefined as never, {
      provider: "cursor",
    } as never);
    expect(discoverModels).not.toHaveBeenCalled();
  });
});
