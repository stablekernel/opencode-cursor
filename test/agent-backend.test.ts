import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/cursor-runtime.js", () => ({
  loadCursorSdk: async () => ({
    Agent: {
      create: async () => ({ agentId: "in-proc", send: async () => ({}), close: () => {} }),
      resume: async () => ({ agentId: "in-proc", send: async () => ({}), close: () => {} }),
    },
  }),
}));

const { resolveBackendKind, resolveSidecarScript } = await import(
  "../src/provider/agent-backend.js"
);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveSidecarScript", () => {
  it("locates the agent-host script regardless of bundle layout", () => {
    // From src/ the .mjs source must be found; from dist/ the bundled .js
    // (lives in dist/sidecar/ while the importer may be a root-level chunk).
    const script = resolveSidecarScript();
    expect(script).toMatch(/sidecar[/\\]agent-host\.(mjs|js)$/);
  });
});

describe("resolveBackendKind", () => {
  it("uses in-process under node (no Bun global)", () => {
    expect(resolveBackendKind({ isBun: false, nodePath: "/usr/bin/node" })).toBe("in-process");
  });

  it("uses the sidecar under bun when node is available", () => {
    expect(resolveBackendKind({ isBun: true, nodePath: "/usr/bin/node" })).toBe("sidecar");
  });

  it("falls back to in-process under bun when node is missing", () => {
    expect(resolveBackendKind({ isBun: true, nodePath: undefined })).toBe("in-process");
  });

  it("honors OPENCODE_CURSOR_SIDECAR=0 override even under bun", () => {
    vi.stubEnv("OPENCODE_CURSOR_SIDECAR", "0");
    expect(resolveBackendKind({ isBun: true, nodePath: "/usr/bin/node" })).toBe("in-process");
  });

  it("honors OPENCODE_CURSOR_SIDECAR=1 override under node", () => {
    vi.stubEnv("OPENCODE_CURSOR_SIDECAR", "1");
    expect(resolveBackendKind({ isBun: false, nodePath: "/usr/bin/node" })).toBe("sidecar");
  });
});
