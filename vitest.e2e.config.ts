import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/e2e/**/*.e2e.ts"],
		testTimeout: 300_000,
		hookTimeout: 120_000,
		maxWorkers: 1,
	},
});
