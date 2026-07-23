import { describe, expect, it, vi } from "vitest";

vi.mock("../src/cursor-runtime.js", () => ({
  loadCursorSdk: async () => ({
    Agent: {
      create: async () => ({ agentId: "in-proc", send: async () => ({}), close: () => {} }),
      resume: async () => ({ agentId: "in-proc", send: async () => ({}), close: () => {} }),
    },
  }),
}));

const { resolveSidecarScript } = await import(
  "../src/provider/agent-backend.js"
);

describe("resolveSidecarScript", () => {
  it("locates the agent-host script regardless of bundle layout", () => {
    // From src/ the .mjs source must be found; from dist/ the bundled .js
    // (lives in dist/sidecar/ while the importer may be a root-level chunk).
    const script = resolveSidecarScript();
    expect(script).toMatch(/sidecar[/\\]agent-host\.(mjs|js)$/);
  });
});
