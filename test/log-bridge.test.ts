import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearLogBridge,
  getLogBridge,
  pluginLog,
  setLogBridge,
} from "../src/provider/log-bridge.js";

afterEach(() => {
  clearLogBridge();
});

describe("log bridge", () => {
  it("has no bridge until published", () => {
    expect(getLogBridge()).toBeUndefined();
  });

  it("stores and clears the published bridge", () => {
    const client = { app: { log: vi.fn() } } as never;
    setLogBridge({ client, directory: "/work" });
    expect(getLogBridge()).toMatchObject({ directory: "/work" });
    clearLogBridge();
    expect(getLogBridge()).toBeUndefined();
  });
});

describe("pluginLog", () => {
  it("routes through client.app.log with service/level/message/extra when a bridge is published", () => {
    const log = vi.fn().mockResolvedValue(undefined);
    setLogBridge({ client: { app: { log } } as never, directory: "/work" });

    pluginLog("warn", "something degraded", { reason: "no sidecar" });

    expect(log).toHaveBeenCalledWith({
      body: {
        service: "opencode-cursor",
        level: "warn",
        message: "something degraded",
        extra: { reason: "no sidecar" },
      },
      query: { directory: "/work" },
    });
  });

  it("omits extra and query.directory when not provided", () => {
    const log = vi.fn().mockResolvedValue(undefined);
    setLogBridge({ client: { app: { log } } as never });

    pluginLog("info", "no extras here");

    expect(log).toHaveBeenCalledWith({
      body: { service: "opencode-cursor", level: "info", message: "no extras here" },
    });
  });

  it("swallows a rejected app.log call instead of throwing", async () => {
    const log = vi.fn().mockRejectedValue(new Error("network down"));
    setLogBridge({ client: { app: { log } } as never });

    expect(() => pluginLog("error", "boom")).not.toThrow();
    // Let the fire-and-forget promise settle before the test ends.
    await Promise.resolve();
  });

  it("falls back to console.* when no bridge is published", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    pluginLog("warn", "standalone warning", { foo: "bar" });
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("[opencode-cursor] standalone warning"),
    );
    spy.mockRestore();
  });
});
