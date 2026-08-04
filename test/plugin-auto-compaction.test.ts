import { describe, expect, it } from "vitest";
import type { Config } from "@opencode-ai/plugin";
import plugin from "../src/plugin/index.js";
import { NO_AUTO_COMPACTION_INPUT_LIMIT } from "../src/model-limits.js";

/**
 * These drive the REAL `config` hook, not the pure model-map builders. The
 * option is read with a string key (`existingOptions["autoCompaction"]`), so a
 * typo there is invisible to `tsc` and to the pure-function tests — only a
 * hook-level test can catch it. Mirrors the `forwardMcp:false` pattern in
 * mcp-config.test.ts.
 */
function firstModelLimit(config: Config): Record<string, unknown> {
	const models = config.provider!.cursor!.models as Record<
		string,
		{ limit: Record<string, unknown> }
	>;
	const first = Object.values(models)[0];
	if (!first) throw new Error("no cursor models emitted by the config hook");
	return first.limit;
}

describe("plugin config hook — auto-compaction suppression", () => {
	it("emits the no-auto-compaction input sentinel by default", async () => {
		const hooks = await plugin({} as never);
		const config: Config = {};
		await hooks.config!(config);
		const limit = firstModelLimit(config);
		expect(limit["input"]).toBe(NO_AUTO_COMPACTION_INPUT_LIMIT);
		// context stays real so the TUI gauge and cost reporting keep working
		expect(limit["context"]).toBeTypeOf("number");
		expect(limit["context"]).toBeGreaterThan(0);
	});

	it("omits the sentinel when autoCompaction:true is opted in", async () => {
		const hooks = await plugin({} as never);
		const config: Config = {
			provider: { cursor: { options: { autoCompaction: true } } },
		};
		await hooks.config!(config);
		const limit = firstModelLimit(config);
		expect(limit["input"]).toBeUndefined();
		expect(limit["context"]).toBeGreaterThan(0);
	});

	it("treats any non-true value as disabled (sentinel emitted)", async () => {
		for (const value of [false, "true", 1, undefined]) {
			const hooks = await plugin({} as never);
			const config: Config = {
				provider: {
					cursor: { options: { autoCompaction: value } as never },
				},
			};
			await hooks.config!(config);
			expect(firstModelLimit(config)["input"]).toBe(
				NO_AUTO_COMPACTION_INPUT_LIMIT,
			);
		}
	});
});
