import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSystemRule } from "../src/provider/system-rule.js";

// Keep the config hook offline: no live model discovery.
vi.mock("../src/model-discovery.js", () => ({
	discoverModels: async () => ({ models: [], source: "fallback" }),
	toOpencodeModels: () => ({}),
}));

const { default: plugin } = await import("../src/plugin/index.js");

const dirs: string[] = [];
function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), "cursor-plugin-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function rulePath(cwd: string): string {
	return join(cwd, ".cursor", "rules", "opencode.mdc");
}

describe("CursorPlugin system-rule cwd threading", () => {
	it("threads the plugin directory into the provider options as cwd", async () => {
		const dir = tmp();
		const hooks = await plugin({ directory: dir } as never);
		const config = { provider: {}, mcp: {} } as never;
		await hooks.config!(config);
		const options = (config as { provider: Record<string, { options?: Record<string, unknown> }> })
			.provider["cursor"]!.options!;
		expect(options["cwd"]).toBe(dir);
	});

	it("keeps a user-configured provider cwd option and cleans up there on dispose", async () => {
		const dir = tmp();
		const customCwd = tmp();
		const hooks = await plugin({ directory: dir } as never);
		const config = {
			provider: { cursor: { options: { cwd: customCwd } } },
			mcp: {},
		} as never;
		await hooks.config!(config);
		const options = (config as { provider: Record<string, { options?: Record<string, unknown> }> })
			.provider["cursor"]!.options!;
		expect(options["cwd"]).toBe(customCwd);

		writeSystemRule(customCwd, "sys");
		expect(existsSync(rulePath(customCwd))).toBe(true);
		await hooks.dispose!();
		expect(existsSync(rulePath(customCwd))).toBe(false);
	});

	it("removes the generated rule from the plugin directory on dispose", async () => {
		const dir = tmp();
		const hooks = await plugin({ directory: dir } as never);
		const config = { provider: {}, mcp: {} } as never;
		await hooks.config!(config);

		writeSystemRule(dir, "sys");
		expect(existsSync(rulePath(dir))).toBe(true);
		await hooks.dispose!();
		expect(existsSync(rulePath(dir))).toBe(false);
	});
});
