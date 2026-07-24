import { afterEach, describe, expect, it } from "vitest";
import {
	DEFAULT_BUN_TRANSPORT,
	resolveTransport,
	setPreferredTransport,
} from "../src/provider/agent-backend.js";

const ENV_KEYS = ["OPENCODE_CURSOR_TRANSPORT", "OPENCODE_CURSOR_SIDECAR"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	setPreferredTransport(undefined);
});

const bun = { isBun: true, nodePath: "/usr/bin/node" };
const bunNoNode = { isBun: true, nodePath: undefined };
const node = { isBun: false, nodePath: process.execPath };

describe("resolveTransport", () => {
	it("defaults: Bun -> http1 (post-gate), Node -> http2-direct", () => {
		delete process.env.OPENCODE_CURSOR_TRANSPORT;
		delete process.env.OPENCODE_CURSOR_SIDECAR;
		expect(resolveTransport(bun)).toBe("http1");
		expect(resolveTransport(node)).toBe("http2-direct");
		expect(DEFAULT_BUN_TRANSPORT).toBe("http1");
	});

	it("explicit OPENCODE_CURSOR_TRANSPORT wins", () => {
		process.env.OPENCODE_CURSOR_TRANSPORT = "http1";
		expect(resolveTransport(bun)).toBe("http1");
		expect(resolveTransport(node)).toBe("http1");
		process.env.OPENCODE_CURSOR_TRANSPORT = "http2-direct";
		expect(resolveTransport(bun)).toBe("http2-direct");
		process.env.OPENCODE_CURSOR_TRANSPORT = "sidecar";
		expect(resolveTransport(bun)).toBe("sidecar");
	});

	it("sidecar without node degrades: Bun -> http1, Node -> http2-direct", () => {
		process.env.OPENCODE_CURSOR_TRANSPORT = "sidecar";
		expect(resolveTransport(bunNoNode)).toBe("http1");
	});

	it("legacy OPENCODE_CURSOR_SIDECAR maps: 1 -> sidecar, 0 -> Bun http1 / Node http2-direct", () => {
		delete process.env.OPENCODE_CURSOR_TRANSPORT;
		process.env.OPENCODE_CURSOR_SIDECAR = "1";
		expect(resolveTransport(bun)).toBe("sidecar");
		process.env.OPENCODE_CURSOR_SIDECAR = "0";
		expect(resolveTransport(bun)).toBe("http1");
		expect(resolveTransport(node)).toBe("http2-direct");
	});

	it("provider option setPreferredTransport beats env", () => {
		process.env.OPENCODE_CURSOR_TRANSPORT = "sidecar";
		setPreferredTransport("http1");
		expect(resolveTransport(bun)).toBe("http1");
	});
});
