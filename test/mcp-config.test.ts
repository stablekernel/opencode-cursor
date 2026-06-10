import { describe, expect, it } from "vitest";
import type { Config } from "@opencode-ai/plugin";
import { translateMcpServers } from "../src/plugin/mcp-config.js";
import plugin from "../src/plugin/index.js";

describe("translateMcpServers", () => {
  it("maps a local (stdio) server, splitting command/args and keeping env", () => {
    const mcp: Config["mcp"] = {
      serena: {
        type: "local",
        command: ["uvx", "--from", "git+https://github.com/oraios/serena", "serena", "start-mcp-server"],
        environment: { FOO: "bar" },
      },
    };
    expect(translateMcpServers(mcp)).toEqual({
      serena: {
        type: "stdio",
        command: "uvx",
        args: ["--from", "git+https://github.com/oraios/serena", "serena", "start-mcp-server"],
        env: { FOO: "bar" },
      },
    });
  });

  it("maps a remote server to http with headers", () => {
    const mcp: Config["mcp"] = {
      ctx: { type: "remote", url: "https://mcp.example.com", headers: { Authorization: "Bearer x" } },
    };
    expect(translateMcpServers(mcp)).toEqual({
      ctx: { type: "http", url: "https://mcp.example.com", headers: { Authorization: "Bearer x" } },
    });
  });

  it("skips disabled servers and ones missing a command/url", () => {
    const mcp: Config["mcp"] = {
      off: { type: "local", command: ["x"], enabled: false },
      empty: { type: "local", command: [] },
      noUrl: { type: "remote", url: "" },
      ok: { type: "local", command: ["node", "server.js"] },
    };
    expect(translateMcpServers(mcp)).toEqual({
      ok: { type: "stdio", command: "node", args: ["server.js"] },
    });
  });

  it("returns an empty map for undefined", () => {
    expect(translateMcpServers(undefined)).toEqual({});
  });
});

describe("plugin config hook MCP forwarding", () => {
  it("forwards opencode's configured MCP servers into provider.cursor.options", async () => {
    const hooks = await plugin({} as never);
    const config: Config = {
      mcp: { serena: { type: "local", command: ["uvx", "serena"] } },
    };
    await hooks.config!(config);
    const opts = config.provider!.cursor!.options as Record<string, unknown>;
    expect(opts.mcpServers).toEqual({ serena: { type: "stdio", command: "uvx", args: ["serena"] } });
  });

  it("respects forwardMcp:false opt-out", async () => {
    const hooks = await plugin({} as never);
    const config: Config = {
      mcp: { serena: { type: "local", command: ["uvx", "serena"] } },
      provider: { cursor: { options: { forwardMcp: false } } },
    };
    await hooks.config!(config);
    const opts = config.provider!.cursor!.options as Record<string, unknown>;
    expect(opts.mcpServers).toBeUndefined();
  });
});
