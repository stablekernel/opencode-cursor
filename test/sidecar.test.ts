import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SidecarClient } from "../src/provider/sidecar-client.js";

const SCRIPT = fileURLToPath(new URL("../src/sidecar/agent-host.mjs", import.meta.url));
const FAKE_SDK = fileURLToPath(new URL("./fixtures/fake-cursor-sdk.mjs", import.meta.url));

const clients: SidecarClient[] = [];

function makeClient(options?: { idleRecycleMs?: number; loadLog?: string }): SidecarClient {
  const client = new SidecarClient({
    scriptPath: SCRIPT,
    ...(options?.idleRecycleMs !== undefined
      ? { idleRecycleMs: options.idleRecycleMs }
      : {}),
    env: {
      OPENCODE_CURSOR_SDK_PATH: FAKE_SDK,
      ...(options?.loadLog ? { FAKE_SDK_LOAD_LOG: options.loadLog } : {}),
    },
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

  it("preserves error classification fields across the process boundary", async () => {
    const client = makeClient();
    const agent = await client.createAgent(CREATE_OPTIONS);
    await expect(agent.send({ type: "user", text: "rich" }, { mode: "agent" })).rejects.toMatchObject(
      {
        name: "RateLimitError",
        message: "rate limited",
        status: 429,
        code: "rate_limited",
        isRetryable: true,
        helpUrl: "https://example.com/rate-limits",
      },
    );
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

  describe("child recycling", () => {
    let loadLog: string;
    let logSeq = 0;

    afterEach(() => {
      rmSync(loadLog, { force: true });
    });

    /** Fresh per-test log path (avoids cross-test timing bleed). */
    const nextLoadLog = (): string => {
      logSeq += 1;
      loadLog = fileURLToPath(
        new URL(`./fixtures/.load-log-${process.pid}-${logSeq}`, import.meta.url),
      );
      rmSync(loadLog, { force: true });
      return loadLog;
    };

    /** Distinct pids that loaded the fake SDK (one per spawned child). */
    const spawnedPids = (): string[] => [
      ...new Set(
        readFileSync(loadLog, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => line.split(" ")[1]!),
      ),
    ];

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    it("recycles the child after a run ends with status error", async () => {
      const client = makeClient({ loadLog: nextLoadLog() });
      const agent = await client.createAgent(CREATE_OPTIONS);
      const run = await agent.send({ type: "user", text: "error" }, { mode: "agent" });
      await expect(run.wait()).resolves.toMatchObject({ status: "error" });

      // The next turn must run in a fresh child (fresh SDK transport state).
      const next = await client.createAgent(CREATE_OPTIONS);
      const run2 = await next.send({ type: "user", text: "ok" }, { mode: "agent" });
      await expect(run2.wait()).resolves.toMatchObject({ status: "finished" });

      expect(spawnedPids()).toHaveLength(2);
    });

    it("recycles the child after the idle timeout", async () => {
      const client = makeClient({ loadLog: nextLoadLog(), idleRecycleMs: 50 });
      await client.createAgent(CREATE_OPTIONS);
      await sleep(150); // let the idle timer fire
      await client.createAgent(CREATE_OPTIONS);
      expect(spawnedPids()).toHaveLength(2);
    });

    it("keeps one child across healthy turns", async () => {
      const client = makeClient({ loadLog: nextLoadLog(), idleRecycleMs: 60_000 });
      const agent = await client.createAgent(CREATE_OPTIONS);
      const run = await agent.send({ type: "user", text: "ok" }, { mode: "agent" });
      await run.wait();
      await client.createAgent(CREATE_OPTIONS);
      expect(spawnedPids()).toHaveLength(1);
    });

    it("never recycles while a sibling request is still in flight", async () => {
      const client = makeClient({ loadLog: nextLoadLog() });
      const agent = await client.createAgent(CREATE_OPTIONS);
      // A hung send keeps the child busy while another turn errors (stale).
      const hung = await agent.send({ type: "user", text: "hang" }, { mode: "agent" });
      const errored = await agent.send({ type: "user", text: "error" }, { mode: "agent" });
      await expect(errored.wait()).resolves.toMatchObject({ status: "error" });

      // Stale, but the hung send is still pending: no recycle yet.
      await client.createAgent(CREATE_OPTIONS);
      expect(spawnedPids()).toHaveLength(1);

      // Once it settles, the next request lands on a fresh child.
      await hung.cancel();
      // Awaiting wait() guarantees the terminal event (and pending cleanup)
      // has been processed before we assert the recycle.
      await expect(hung.wait()).resolves.toMatchObject({ status: "cancelled" });
      await client.createAgent(CREATE_OPTIONS);
      expect(spawnedPids()).toHaveLength(2);
    });
  });
});
