import { afterEach, describe, expect, it } from "vitest";
import { CURSOR_API_KEY_ENV_VAR, fingerprintApiKey, resolveCursorApiKey } from "../src/api-key.js";

const original = process.env[CURSOR_API_KEY_ENV_VAR];
afterEach(() => {
  if (original === undefined) delete process.env[CURSOR_API_KEY_ENV_VAR];
  else process.env[CURSOR_API_KEY_ENV_VAR] = original;
});

describe("resolveCursorApiKey", () => {
  it("returns an explicit, real key", () => {
    expect(resolveCursorApiKey("key_abc")).toBe("key_abc");
  });

  it("trims whitespace", () => {
    expect(resolveCursorApiKey("  key_abc  ")).toBe("key_abc");
  });

  it("treats placeholders as 'use the env var'", () => {
    process.env[CURSOR_API_KEY_ENV_VAR] = "key_from_env";
    expect(resolveCursorApiKey("CURSOR_API_KEY")).toBe("key_from_env");
    expect(resolveCursorApiKey("$CURSOR_API_KEY")).toBe("key_from_env");
    expect(resolveCursorApiKey("${CURSOR_API_KEY}")).toBe("key_from_env");
  });

  it("falls back to the env var when no candidate", () => {
    process.env[CURSOR_API_KEY_ENV_VAR] = "key_env";
    expect(resolveCursorApiKey()).toBe("key_env");
    expect(resolveCursorApiKey(undefined)).toBe("key_env");
  });

  it("returns undefined when nothing is available", () => {
    delete process.env[CURSOR_API_KEY_ENV_VAR];
    expect(resolveCursorApiKey()).toBeUndefined();
    expect(resolveCursorApiKey("")).toBeUndefined();
  });
});

describe("fingerprintApiKey", () => {
  it("is deterministic and non-reversible (16 hex chars)", () => {
    const fp = fingerprintApiKey("key_secret");
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprintApiKey("key_secret")).toBe(fp);
    expect(fp).not.toContain("secret");
  });

  it("differs for different keys", () => {
    expect(fingerprintApiKey("a")).not.toBe(fingerprintApiKey("b"));
  });
});
