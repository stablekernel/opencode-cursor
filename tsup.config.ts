import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

let pkg: { version: string };
try {
	pkg = JSON.parse(
		readFileSync(new URL("./package.json", import.meta.url), "utf8"),
	) as { version: string };
} catch (error) {
	throw new Error(
		`tsup: failed to read/parse package.json: ${
			error instanceof Error ? error.message : String(error)
		}`,
	);
}

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
		// stdio MCP server exposing other plugins' custom tools to the Cursor
		// agent. Spawned by Cursor (via mcpServers) when the bridge is active.
		"sidecar/plugin-tools-mcp": "src/sidecar/plugin-tools-mcp.mjs",
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
	external: ["@cursor/sdk", "@ai-sdk/provider", "@opencode-ai/plugin"],
});
