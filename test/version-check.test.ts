import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { join } from "node:path";
import semver from "semver";

const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

const realPkg = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

// Local version injected for tests so expectations don't couple to the real
// package.json version. `getLocalVersion` reads the free identifier
// `__PKG_VERSION__`, which resolves to this globalThis property when tsup's
// build-time `define` hasn't inlined it.
const LOCAL_VERSION = "1.0.0";
const NEWER_VERSION = "2.0.0";
const OLDER_VERSION = "0.1.0";

const fsState: Record<string, string> = {};
let requestHandlers: {
  onResponse?: (res: MockResponse) => void;
  onError?: () => void;
  onTimeout?: () => void;
} = {};

class MockResponse extends EventEmitter {
  setEncoding = vi.fn();
  resume = vi.fn();
  statusCode = 200;
}

class MockRequest extends EventEmitter {
  setTimeout = vi.fn((_ms: number, cb: () => void) => {
    requestHandlers.onTimeout = cb;
  });
  destroy = vi.fn();
}

const get = vi.fn((_url: string, _opts: object, cb: (res: MockResponse) => void) => {
  const req = new MockRequest();
  requestHandlers.onResponse = (res) => cb(res);
  return req;
});

vi.mock("node:https", () => ({ get }));

vi.mock("node:fs", () => ({
  mkdirSync: vi.fn((_path: string, _opts?: object) => {}),
  readFileSync: vi.fn((path: string, _encoding: string) => {
    if (fsState[path]) return fsState[path];
    throw new Error("ENOENT");
  }),
  writeFileSync: vi.fn((path: string, data: string, _encoding: string) => {
    fsState[path] = data;
  }),
  rmSync: vi.fn(),
}));

const { warnIfStale } = await import("../src/version-check.js");

function respondWithRaw(body: string | undefined, statusCode = 200) {
  const res = new MockResponse();
  res.statusCode = statusCode;
  process.nextTick(() => {
    if (body !== undefined) res.emit("data", body);
    res.emit("end");
  });
  requestHandlers.onResponse?.(res);
}

function respondWith(version: string | undefined, statusCode = 200) {
  respondWithRaw(
    version === undefined ? undefined : JSON.stringify({ version }),
    statusCode,
  );
}

function cachePath(): string {
  return join(
    process.env.HOME || "/tmp",
    ".cache/opencode-cursor/version-check.json",
  );
}

describe("warnIfStale", () => {
  beforeEach(() => {
    consoleWarn.mockClear();
    Object.keys(fsState).forEach((k) => delete fsState[k]);
    requestHandlers = {};
    get.mockClear();
    // Neutralize real CI env so the escape hatch doesn't skip the check.
    vi.stubEnv("CI", "");
    vi.stubEnv("NO_UPDATE_NOTIFIER", "");
    (globalThis as Record<string, unknown>).__PKG_VERSION__ = LOCAL_VERSION;
  });

  afterEach(() => {
    consoleWarn.mockReset();
    vi.unstubAllEnvs();
    delete (globalThis as Record<string, unknown>).__PKG_VERSION__;
  });

  it("warns when registry latest is newer than local version", async () => {
    const promise = warnIfStale();
    respondWith(NEWER_VERSION);
    await promise;
    expect(consoleWarn).toHaveBeenCalledOnce();
    expect(String(consoleWarn.mock.calls[0]?.[0])).toContain(NEWER_VERSION);
  });

  it("does not warn when local version equals latest", async () => {
    const promise = warnIfStale();
    respondWith(LOCAL_VERSION);
    await promise;
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it("does not warn when local version is newer", async () => {
    const promise = warnIfStale();
    respondWith(OLDER_VERSION);
    await promise;
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it("falls back to the real package.json version when no build-time version is defined", async () => {
    delete (globalThis as Record<string, unknown>).__PKG_VERSION__;
    const newer = semver.inc(realPkg.version, "major");
    const promise = warnIfStale();
    respondWith(newer ?? "99.0.0");
    await promise;
    expect(consoleWarn).toHaveBeenCalledOnce();
    expect(String(consoleWarn.mock.calls[0]?.[0])).toContain(realPkg.version);
  });

  it("does not warn when registry fetch fails", async () => {
    const promise = warnIfStale();
    const res = new MockResponse();
    requestHandlers.onResponse?.(res);
    process.nextTick(() => res.emit("error", new Error("network")));
    await promise;
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it("does not warn or throw on a malformed JSON body", async () => {
    const promise = warnIfStale();
    respondWithRaw("<html>not json</html>");
    await expect(promise).resolves.toBeUndefined();
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it("does not warn on a non-200 registry response", async () => {
    const promise = warnIfStale();
    respondWith(NEWER_VERSION, 500);
    await promise;
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it("does not warn or throw when the registry returns an invalid version string", async () => {
    const promise = warnIfStale();
    respondWith("not-a-version");
    await expect(promise).resolves.toBeUndefined();
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it("skips the check entirely when CI is set", async () => {
    vi.stubEnv("CI", "true");
    await warnIfStale();
    expect(get).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it("skips the check entirely when NO_UPDATE_NOTIFIER is set", async () => {
    vi.stubEnv("NO_UPDATE_NOTIFIER", "1");
    await warnIfStale();
    expect(get).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it("uses cached result within 24h", async () => {
    fsState[cachePath()] = JSON.stringify({
      checkedAt: Date.now(),
      latest: "9.9.9",
    });
    await warnIfStale();
    expect(get).not.toHaveBeenCalled();
    expect(consoleWarn).toHaveBeenCalledOnce();
  });

  it("re-fetches when a cached failure is older than the failure TTL", async () => {
    fsState[cachePath()] = JSON.stringify({
      checkedAt: Date.now() - 2 * 60 * 60 * 1000, // 2h ago
      latest: undefined,
    });
    const promise = warnIfStale();
    respondWith(NEWER_VERSION);
    await promise;
    expect(get).toHaveBeenCalledOnce();
    expect(consoleWarn).toHaveBeenCalledOnce();
  });

  it("does not re-fetch a recent cached failure", async () => {
    fsState[cachePath()] = JSON.stringify({
      checkedAt: Date.now() - 30 * 60 * 1000, // 30min ago
      latest: undefined,
    });
    await warnIfStale();
    expect(get).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it("emits a windows removal command on win32", async () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const promise = warnIfStale();
      respondWith(NEWER_VERSION);
      await promise;
      expect(consoleWarn).toHaveBeenCalledOnce();
      const message = String(consoleWarn.mock.calls[0]?.[0]);
      expect(message).toContain("rmdir /s /q");
      expect(message).not.toContain("rm -rf");
    } finally {
      Object.defineProperty(process, "platform", { value: original });
    }
  });

  it("emits rm -rf on non-windows platforms", async () => {
    const promise = warnIfStale();
    respondWith(NEWER_VERSION);
    await promise;
    expect(String(consoleWarn.mock.calls[0]?.[0])).toContain("rm -rf");
  });
});
