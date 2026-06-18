import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { join } from "node:path";

const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

const fsState: Record<string, string> = {};
let lastRequestUrl: string | undefined;
let requestHandlers: {
  onResponse?: (res: MockResponse) => void;
  onError?: () => void;
  onTimeout?: () => void;
} = {};

class MockResponse extends EventEmitter {
  setEncoding = vi.fn();
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

function respondWith(version: string | undefined) {
  const res = new MockResponse();
  process.nextTick(() => {
    if (version === undefined) {
      res.emit("end");
    } else {
      res.emit("data", JSON.stringify({ version }));
      res.emit("end");
    }
  });
  requestHandlers.onResponse?.(res);
}

describe("warnIfStale", () => {
  beforeEach(() => {
    consoleWarn.mockClear();
    Object.keys(fsState).forEach((k) => delete fsState[k]);
    lastRequestUrl = undefined;
    requestHandlers = {};
    get.mockClear();
  });

  afterEach(() => {
    consoleWarn.mockReset();
  });

  it("warns when registry latest is newer than local version", async () => {
    const promise = warnIfStale();
    respondWith("0.5.0");
    await promise;
    expect(consoleWarn).toHaveBeenCalledOnce();
    expect(String(consoleWarn.mock.calls[0]?.[0])).toContain("0.5.0");
  });

  it("does not warn when local version equals latest", async () => {
    const promise = warnIfStale();
    respondWith("0.4.1");
    await promise;
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it("does not warn when local version is newer", async () => {
    const promise = warnIfStale();
    respondWith("0.3.0");
    await promise;
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it("does not warn when registry fetch fails", async () => {
    const promise = warnIfStale();
    const res = new MockResponse();
    requestHandlers.onResponse?.(res);
    process.nextTick(() => res.emit("error", new Error("network")));
    await promise;
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it("uses cached result within 24h", async () => {
    // Seed cache with latest=9.9.9
    fsState[join(process.env.HOME || "/tmp", ".cache/opencode-cursor/version-check.json")] =
      JSON.stringify({ checkedAt: Date.now(), latest: "9.9.9" });
    await warnIfStale();
    expect(get).not.toHaveBeenCalled();
    expect(consoleWarn).toHaveBeenCalledOnce();
  });
});
