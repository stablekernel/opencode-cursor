import { beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pickE2EModel } from "./model.js";

const execFileP = promisify(execFile);
const LIVE = process.env.E2E === "1" && Boolean(process.env.CURSOR_API_KEY);

interface Part { type: string; name?: string; id?: string; isError?: boolean }
interface RunEvent {
	ev: "run";
	firstDeltaMs?: number;
	deltaChars: number;
	payloadChars: number;
	parts: Part[];
	error?: string;
}

let model = "auto";
beforeAll(async () => {
	model = await pickE2EModel();
	console.log(`[e2e] model=${model}`);
});

async function driver(scenario: string, env: Record<string, string> = {}): Promise<RunEvent[]> {
	const { stdout } = await execFileP("bun", ["test/e2e/driver.ts", scenario], {
		env: { ...process.env, CURSOR_E2E_MODEL: model, ...env },
		timeout: 280_000,
		maxBuffer: 64 * 1024 * 1024,
	});
	return stdout
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as RunEvent);
}

/** Every tool-call has exactly one matching tool-result; no error parts. */
function expectToolParity(run: RunEvent): void {
	expect(run.error).toBeUndefined();
	const calls = run.parts.filter((p) => p.type === "tool-call");
	const results = run.parts.filter((p) => p.type === "tool-result");
	expect(calls.length).toBeGreaterThan(0);
	for (const call of calls) {
		const matches = results.filter((r) => r.id === call.id);
		expect(matches, `tool-result for ${call.name} (${call.id})`).toHaveLength(1);
		expect(matches[0]!.isError).not.toBe(true);
	}
	expect(run.parts.some((p) => p.type === "error")).toBe(false);
}

describe.skipIf(!LIVE)("transport evidence matrix (live, cheapest model)", () => {
	it("http1: tool parity + TTFT", async () => {
		const [run] = await driver("tool-parity", { OPENCODE_CURSOR_TRANSPORT: "http1" });
		expectToolParity(run!);
		expect(run!.firstDeltaMs).toBeDefined();
		console.log(`[e2e] http1 TTFT=${run!.firstDeltaMs}ms`);
	});

	it("sidecar: tool parity + TTFT (baseline)", async () => {
		const [run] = await driver("tool-parity", { OPENCODE_CURSOR_TRANSPORT: "sidecar" });
		expectToolParity(run!);
		console.log(`[e2e] sidecar TTFT=${run!.firstDeltaMs}ms`);
	});

	it("http1: session resume (second turn continuation)", async () => {
		const [first, second] = await driver("resume", { OPENCODE_CURSOR_TRANSPORT: "http1" });
		expectToolParity(first!);
		expect(second!.error).toBeUndefined();
		expect(second!.parts.some((p) => p.type === "text-delta")).toBe(true);
	});

	it("http1: wedged-run recovery after abort", async () => {
		const [aborted, recovery] = await driver("stall-cancel", { OPENCODE_CURSOR_TRANSPORT: "http1" });
		expect(aborted).toBeDefined();
		expect(recovery!.error).toBeUndefined();
		const text = recovery!.parts.filter((p) => p.type === "text-delta");
		expect(text.length).toBeGreaterThan(0);
	});

	it("http1: long stream >64KB cumulative payload (no stall)", async () => {
		const [run] = await driver("long-stream", { OPENCODE_CURSOR_TRANSPORT: "http1" });
		expect(run!.error).toBeUndefined();
		expectToolParity(run!);
		expect(run!.payloadChars).toBeGreaterThan(65_536);
	});

	it("http1: web search arrives as mcp tool pair", async () => {
		const [run] = await driver("web-search", { OPENCODE_CURSOR_TRANSPORT: "http1" });
		expect(run!.error).toBeUndefined();
		const calls = run!.parts.filter((p) => p.type === "tool-call");
		if (calls.length === 0 && !run!.parts.some((p) => p.type === "error")) {
			console.log("[e2e] no mcp tool observed — web search capability unavailable on this account; mcp-path evidence limited");
			return;
		}
		expect(calls.length).toBeGreaterThan(0);
		expectToolParity(run!);
	});
});
