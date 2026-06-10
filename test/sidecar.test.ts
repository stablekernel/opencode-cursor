import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { SidecarClient } from "../src/provider/sidecar-client.js";

const SCRIPT = fileURLToPath(new URL("../src/sidecar/agent-host.mjs", import.meta.url));
const FAKE_SDK = fileURLToPath(new URL("./fixtures/fake-cursor-sdk.mjs", import.meta.url));

const clients: SidecarClient[] = [];

function makeClient(): SidecarClient {
  const client = new SidecarClient({
    scriptPath: SCRIPT,
    env: { OPENCODE_CURSOR_SDK_PATH: FAKE_SDK },
  });
  clients.push(client);
  return client;
}

afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
});

const CREATE_OPTIONS = { apiKey: "k", model: { id: "m" }, local: { cwd: "/tmp" } };

describe("SidecarClient", () => {
  it("creates an agent in the child and streams a turn back", async () => {
    const client = makeClient();
    const agent = await client.createAgent(CREATE_OPTIONS);
    expect(agent.agentId).toBe("agent-created");

    const updates: Array<{ type: string }> = [];
    const run = await agent.send(
      { type: "user", text: "hi" },
      { mode: "agent", onDelta: ({ update }) => updates.push(update as { type: string }) },
    );
    const result = await run.wait();

    expect(updates).toContainEqual({ type: "text-delta", text: "echo:hi" });
    expect(result).toMatchObject({ status: "finished", result: "done:hi" });
  });

  it("resumes an existing agent by id", async () => {
    const client = makeClient();
    const agent = await client.resumeAgent("agent-42", CREATE_OPTIONS);
    expect(agent.agentId).toBe("agent-42");
  });

  it("preserves error names across the process boundary", async () => {
    const client = makeClient();
    // Resume failure name drives session-pool's create fallback.
    await expect(client.resumeAgent("missing", CREATE_OPTIONS)).rejects.toMatchObject({
      name: "AgentNotFoundError",
    });

    // Busy failure name drives agent-events' local.force retry.
    const agent = await client.createAgent(CREATE_OPTIONS);
    await expect(agent.send({ type: "user", text: "busy" }, { mode: "agent" })).rejects.toMatchObject(
      { name: "AgentBusyError" },
    );
    // And the retry path (local.force) goes through cleanly.
    const run = await agent.send(
      { type: "user", text: "busy" },
      { mode: "agent", local: { force: true } },
    );
    await expect(run.wait()).resolves.toMatchObject({ status: "finished" });
  });

  it("multiplexes concurrent sends over one child", async () => {
    const client = makeClient();
    const [a, b] = await Promise.all([
      client.createAgent(CREATE_OPTIONS),
      client.resumeAgent("agent-b", CREATE_OPTIONS),
    ]);
    const [runA, runB] = await Promise.all([
      a.send({ type: "user", text: "one" }, { mode: "agent" }),
      b.send({ type: "user", text: "two" }, { mode: "agent" }),
    ]);
    const [resA, resB] = await Promise.all([runA.wait(), runB.wait()]);
    expect(resA).toMatchObject({ result: "done:one" });
    expect(resB).toMatchObject({ result: "done:two" });
  });

  it("cancel() reaches the child and resolves the hung run", async () => {
    const client = makeClient();
    const agent = await client.createAgent(CREATE_OPTIONS);
    const run = await agent.send({ type: "user", text: "hang" }, { mode: "agent" });
    await run.cancel();
    await expect(run.wait()).resolves.toMatchObject({ status: "cancelled" });
  });

  it("rejects in-flight requests when the client is disposed", async () => {
    const client = makeClient();
    const agent = await client.createAgent(CREATE_OPTIONS);
    const run = await agent.send({ type: "user", text: "hang" }, { mode: "agent" });
    const waited = run.wait();
    client.dispose();
    await expect(waited).rejects.toThrow(/sidecar/i);
  });
});
