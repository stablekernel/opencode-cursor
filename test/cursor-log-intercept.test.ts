import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installCursorLogInterceptor,
  parseCursorRuleLoadLine,
  resetCursorLogInterceptor,
} from "../src/provider/cursor-log-intercept.js";
import { clearLogBridge, setLogBridge } from "../src/provider/log-bridge.js";

afterEach(() => {
  resetCursorLogInterceptor();
  clearLogBridge();
});

describe("parseCursorRuleLoadLine", () => {
  it("parses LocalCursorRulesService with a two-field meta", () => {
    const parsed = parseCursorRuleLoadLine(
      "16:05:53.036 INFO  LocalCursorRulesService load completed meta={durationMs: 89, ruleCount: 1}",
    );
    expect(parsed).toEqual({
      service: "LocalCursorRulesService",
      meta: { durationMs: 89, ruleCount: 1 },
    });
  });

  it("parses AgentSkillsCursorRulesService with a three-field meta", () => {
    const parsed = parseCursorRuleLoadLine(
      "16:05:53.036 INFO  AgentSkillsCursorRulesService load completed meta={durationMs: 86, ruleCount: 18, skillCount: 18}",
    );
    expect(parsed).toEqual({
      service: "AgentSkillsCursorRulesService",
      meta: { durationMs: 86, ruleCount: 18, skillCount: 18 },
    });
  });

  it("parses CursorPluginsAgentSkillsService", () => {
    const parsed = parseCursorRuleLoadLine(
      "16:05:53.036 INFO  CursorPluginsAgentSkillsService load completed meta={durationMs: 12, ruleCount: 2, skillCount: 0}",
    );
    expect(parsed?.service).toBe("CursorPluginsAgentSkillsService");
  });

  it("strips ANSI color codes before matching", () => {
    const parsed = parseCursorRuleLoadLine(
      "\x1b[2m16:05:53.036\x1b[0m \x1b[34mINFO \x1b[0m LocalCursorRulesService load completed \x1b[2mmeta=\x1b[0m{durationMs: 5, ruleCount: 0}",
    );
    expect(parsed).toEqual({
      service: "LocalCursorRulesService",
      meta: { durationMs: 5, ruleCount: 0 },
    });
  });

  it("returns undefined for unrelated log lines", () => {
    expect(parseCursorRuleLoadLine("some unrelated cursor sdk output")).toBeUndefined();
    expect(parseCursorRuleLoadLine("Plugins reload completed: 3 plugins loaded")).toBeUndefined();
  });
});

describe("installCursorLogInterceptor", () => {
  it("routes recognized lines through pluginLog and passes everything else to the original console.log", () => {
    const log = vi.fn().mockResolvedValue(undefined);
    setLogBridge({ client: { app: { log } } as never });

    const passthrough = vi.spyOn(console, "log").mockImplementation(() => {});
    installCursorLogInterceptor();

    console.log(
      "16:05:53.036 INFO  LocalCursorRulesService load completed meta={durationMs: 89, ruleCount: 1}",
    );
    console.log("totally unrelated output", 42);

    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith({
      body: {
        service: "opencode-cursor",
        level: "info",
        message: "LocalCursorRulesService load completed",
        extra: { durationMs: 89, ruleCount: 1 },
      },
    });

    resetCursorLogInterceptor();
    // The spy is the pre-interceptor console.log; passthrough calls must
    // reach it, but the recognized line must not.
    expect(passthrough).toHaveBeenCalledTimes(1);
    expect(passthrough).toHaveBeenCalledWith("totally unrelated output", 42);
    passthrough.mockRestore();
  });

  it("is idempotent across repeated installs", () => {
    installCursorLogInterceptor();
    const first = console.log;
    installCursorLogInterceptor();
    expect(console.log).toBe(first);
  });

  it("restores the original console.log on reset", () => {
    const passthrough = vi.spyOn(console, "log").mockImplementation(() => {});
    installCursorLogInterceptor();
    resetCursorLogInterceptor();
    console.log("plain line after reset");
    expect(passthrough).toHaveBeenCalledWith("plain line after reset");
    passthrough.mockRestore();
  });
});
