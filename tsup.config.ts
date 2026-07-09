import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(
	readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
	// Emit config (src-only rootDir + declaration); the root tsconfig.json is the
	// broad editor/typecheck project that also covers test/.
	tsconfig: "tsconfig.build.json",
	entry: {
		"provider/index": "src/provider/index.ts",
		"plugin/index": "src/plugin/index.ts",
		"tui/index": "src/tui/index.tsx",
		// Node sidecar hosting @cursor/sdk traffic when the plugin runs under Bun
		// (Bun's node:http2 breaks Cursor's streaming RPC). Spawned, not imported.
		"sidecar/agent-host": "src/sidecar/agent-host.mjs",
	},
	format: ["esm"],
	target: "node22",
	dts: true,
	clean: true,
	sourcemap: true,
	// Bake the package version into the bundle: in dist/, version-check.ts can't
	// resolve ../package.json (it would point inside dist/), so the version is
	// inlined at build time instead.
	define: { __PKG_VERSION__: JSON.stringify(pkg.version) },
	// @cursor/sdk is heavy and resolved at runtime; keep these external.
	external: [
		"@cursor/sdk",
		"@ai-sdk/provider",
		"@opencode-ai/plugin",
		"@opentui/core",
		"@opentui/solid",
	],
});
