import { defineConfig } from "tsup";

export default defineConfig({
	// Emit config (src-only rootDir + declaration); the root tsconfig.json is the
	// broad editor/typecheck project that also covers test/.
	tsconfig: "tsconfig.build.json",
	entry: {
		"provider/index": "src/provider/index.ts",
		"plugin/index": "src/plugin/index.ts",
		// Node sidecar hosting @cursor/sdk traffic when the plugin runs under Bun
		// (Bun's node:http2 breaks Cursor's streaming RPC). Spawned, not imported.
		"sidecar/agent-host": "src/sidecar/agent-host.mjs",
	},
	format: ["esm"],
	target: "node22",
	dts: true,
	clean: true,
	sourcemap: true,
	// @cursor/sdk is heavy and resolved at runtime; keep these external.
	external: ["@cursor/sdk", "@ai-sdk/provider", "@opencode-ai/plugin"],
});
