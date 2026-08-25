/**
 * Mirror the `tool` maps of other installed opencode plugins so the Cursor
 * agent can call them through a local MCP bridge.
 *
 * How it works: opencode loads plugins in `config.plugin` order and executes
 * their `hooks.tool` definitions in-process (`tool/registry.ts`). A sibling
 * plugin registered *after* them can re-`import()` the same module and invoke
 * its exported `server`/default function to read the identical `hooks.tool`
 * map — the exact closures opencode will execute. The mirror never runs a
 * plugin's lifecycle hooks (`config`, `event`, `chat.*`); it only reads the
 * `tool` map and forwards `execute` calls, with the host plugin providing a
 * real `context.ask` so the user's permission config still gates every call.
 *
 * What is mirrored:
 *  - `config.plugin` specs that are bare package names or `name@latest` /
 *    `@scope/name@latest` (resolved against the opencode package cache).
 *  - git specs (`name@git+https:...`) when the cache entry resolves.
 *  - explicit local file paths (`.ts`/`.js`), imported directly.
 * Skipped: anything that fails to import/init (logged, never fatal), and the
 * `@stablekernel/opencode-cursor` spec itself (never mirror ourselves).
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { tool } from "@opencode-ai/plugin";
import type { Config, ToolDefinition } from "@opencode-ai/plugin";
import { opencodePackagesRoot } from "./skill-discovery.js";

/** Our own spec, excluded from mirroring (never mirror ourselves). */
const SELF_SPECS = new Set([
	"@stablekernel/opencode-cursor",
	"@stablekernel/opencode-cursor@latest",
]);

/** A tool definition mirrored from another plugin, ready to execute. */
export interface MirroredTool {
	id: string;
	description: string;
	parameters: Record<string, unknown>;
	execute: ToolDefinition["execute"];
	/** The plugin the tool came from (for logging/permission keys). */
	sourcePlugin: string;
}

export interface MirrorPluginToolsOptions {
	/** Only mirror tools whose id matches one of these patterns. */
	include?: string[];
	/** Never mirror tools whose id matches one of these patterns. */
	exclude?: string[];
	/** Override the package cache root (tests). */
	cacheRoot?: string;
}

export interface MirrorResult {
	tools: MirroredTool[];
	/** Specs that were attempted but failed (id → reason). */
	failed: Record<string, string>;
}

/**
 * Best-effort parse of a `config.plugin` entry into a resolvable form.
 * Entries may be `name`, `name@latest`, `@scope/name[@latest]`,
 * `name@git+<url>`, or a filesystem path. Returns undefined for entries we
 * don't attempt to mirror (relative paths, URL-only specs).
 */
export function parsePluginSpec(
	spec: string,
):
	| { kind: "npm"; name: string; version?: string }
	| { kind: "git"; name: string; raw: string }
	| { kind: "path"; path: string }
	| { kind: "unsupported"; raw: string }
	| undefined {
	const trimmed = spec.trim();
	if (!trimmed) return undefined;
	// Filesystem paths: absolute, or explicitly relative.
	if (
		trimmed.startsWith("/") ||
		trimmed.startsWith("./") ||
		trimmed.startsWith("../") ||
		trimmed.startsWith("~/") ||
		/\.[cm]?[jt]sx?$/.test(trimmed)
	) {
		const expanded = trimmed.startsWith("~/")
			? join(homedir(), trimmed.slice(2))
			: trimmed;
		return { kind: "path", path: expanded };
	}
	// npm spec: `name`, `name@latest`, `@scope/name@version`.
	const at = trimmed.lastIndexOf("@");
	if (at > 0) {
		const name = trimmed.slice(0, at);
		const version = trimmed.slice(at + 1);
		// Git specs (`git+https:...`) land in the cache under the raw spec
		// string. Other URL forms (tarball specs) are valid npm but never
		// appear in opencode's cache layout — mark them unsupported instead
		// of misclassifying them as git.
		if (version.startsWith("git+")) {
			return { kind: "git", name, raw: trimmed };
		}
		if (version.includes("://")) {
			return { kind: "unsupported", raw: trimmed };
		}
		return { kind: "npm", name, version };
	}
	return { kind: "npm", name: trimmed };
}

/**
 * Locate a plugin's install directory in the opencode package cache for an
 * npm or git spec. Tries the layouts opencode produces: `<name>@latest`,
 * `<name>@<version>`, bare `<name>`, and (for git specs) the spec string
 * verbatim with any nesting depth.
 */
export function resolveCacheEntry(
	cacheRoot: string,
	parsed:
		| { kind: "npm"; name: string; version?: string }
		| { kind: "git"; name: string; raw: string }
		| { kind: "unsupported"; raw: string },
): string | undefined {
	if (parsed.kind === "unsupported") return undefined;
	if (parsed.kind === "git") {
		// Git specs land as the spec string itself, potentially nested
		// (superpowers@git+https:/github.com/owner/repo.git). Walk bounded.
		const parts = parsed.raw.split("/");
		let current = cacheRoot;
		for (const part of parts) {
			const candidate = join(current, part);
			if (!existsSync(candidate)) return undefined;
			current = candidate;
		}
		return current;
	}
	const { name, version } = parsed;
	const candidates = [
		version ? join(cacheRoot, `${name}@${version}`) : undefined,
		join(cacheRoot, `${name}@latest`),
		join(cacheRoot, name),
	].filter((c): c is string => Boolean(c));
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

/**
 * Resolve a cache entry's importable module path via its package.json
 * (`main` / `exports`), matching how opencode itself loads the plugin. A
 * scoped or nested `node_modules` root is used for require-resolution so
 * relative `main` paths land inside the package dir.
 */
function resolvePackageMain(
	cacheEntry: string,
	pkgDir: string,
	name: string,
): string | undefined {
	const tryRequire = (baseDir: string): string | undefined => {
		try {
			const req = createRequire(join(baseDir, "noop.js"));
			return req.resolve(name);
		} catch {
			return undefined;
		}
	};
	// Prefer resolution from the package dir itself (handles `exports`),
	// then from the cache entry root (handles bare `main` layouts).
	return tryRequire(pkgDir) ?? tryRequire(cacheEntry);
}

/** The package root inside a cache entry: `node_modules/<pkg>`. */
function packageRoot(cacheEntry: string, name: string): string | undefined {
	const direct = join(cacheEntry, "node_modules", name);
	if (existsSync(direct)) return direct;
	// Fallback: first node_modules child (git specs nest the real package).
	const nm = join(cacheEntry, "node_modules");
	if (!existsSync(nm)) return undefined;
	let entries: Dirent[];
	try {
		entries = readdirSync(nm, { withFileTypes: true });
	} catch {
		return undefined;
	}
	for (const ent of entries) {
		if (ent.name === ".bin") continue;
		const full = join(nm, ent.name);
		let isDir = ent.isDirectory();
		if (!isDir && ent.isSymbolicLink()) {
			try {
				isDir = statSync(full).isDirectory();
			} catch {
				isDir = false;
			}
		}
		if (isDir) return full;
	}
	return undefined;
}

/** Extract a JSON Schema from a plugin's Zod-or-plain args map. */
export function argsToJsonSchema(args: unknown): Record<string, unknown> {
	if (args == null || typeof args !== "object")
		return { type: "object", properties: {}, required: [] };
	const entries = Object.entries(args as Record<string, unknown>);
	const allZod = entries.length > 0 && entries.every(([, v]) => isZodType(v));
	if (allZod) {
		try {
			// `tool.schema` is the same Zod instance opencode bundles plugins
			// against, so `_zod`-shaped args always parse with it. zod v4
			// exposes toJSONSchema; keep the call dynamic so this module also
			// typechecks against a zod v3 root (legacy path below covers it).
			// SAFETY: `tool.schema` is always a Zod namespace object exposing
			// `object()`; `toJSONSchema` is only present on Zod v4 builds, so
			// the cast widens to a shape that makes both versions typecheck.
			const zodLike = tool.schema as unknown as {
				object: (shape: unknown) => unknown;
				toJSONSchema?: (schema: unknown, opts?: unknown) => Record<string, unknown>;
			};
			if (typeof zodLike.toJSONSchema === "function") {
				const schema = zodLike.toJSONSchema(zodLike.object(args), {
					io: "input",
				});
				return normalizeZodSchema(schema);
			}
		} catch {
			// fall through to the legacy path
		}
	}
	// Legacy: treat non-Zod entries as raw JSON Schema properties.
	const properties: Record<string, unknown> = {};
	for (const [key, value] of entries) {
		if (
			typeof value === "boolean" ||
			(typeof value === "object" && value !== null && !Array.isArray(value))
		) {
			properties[key] = value;
		}
	}
	return { type: "object", properties, required: Object.keys(properties) };
}

function isZodType(value: unknown): boolean {
	return typeof value === "object" && value !== null && "_zod" in value;
}

/**
 * Zod v4 emits `$schema` and `definitions`/`$defs` blocks; Cursor's MCP
 * layer only needs a plain object schema, so strip the meta fields and
 * inline nothing (definitions are referenced by name and MCP accepts them).
 */
function normalizeZodSchema(
	schema: Record<string, unknown>,
): Record<string, unknown> {
	const out = { ...schema };
	delete out["$schema"];
	return out;
}

/** Read the `tool` map from a loaded plugin module's hooks. */
function extractToolMap(
	hooks: unknown,
): Record<string, ToolDefinition> | undefined {
	if (!hooks || typeof hooks !== "object") return undefined;
	const tool = (hooks as { tool?: unknown }).tool;
	if (!tool || typeof tool !== "object") return undefined;
	const out: Record<string, ToolDefinition> = {};
	for (const [id, def] of Object.entries(tool as Record<string, unknown>)) {
		if (isPluginTool(def)) out[id] = def;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function isPluginTool(value: unknown): value is ToolDefinition {
	return (
		typeof value === "object" &&
		value !== null &&
		"args" in value &&
		"description" in value &&
		"execute" in value
	);
}

/**
 * Load one plugin module and read its `tool` map. The plugin's `server`
 * function is invoked with a minimal input shaped like opencode's
 * `PluginInput`; only fields the plugin touches at load time matter, and
 * most read nothing until hook execution. Throws on import/init failure —
 * callers collect the error.
 */
async function loadToolMap(
	modulePath: string,
	input: unknown,
): Promise<Record<string, ToolDefinition> | undefined> {
	const mod = (await import(pathToFileURL(modulePath).href)) as Record<
		string,
		unknown
	>;
	// Preferred export shapes, in order: `server`, `default`, then any
	// function export (some plugins export a single named factory).
	const candidates = [mod["server"], mod["default"]];
	for (const value of Object.values(mod)) {
		if (typeof value === "function" && !candidates.includes(value)) {
			candidates.push(value);
		}
	}
	for (const candidate of candidates) {
		if (typeof candidate !== "function") continue;
		let hooks: unknown;
		try {
			hooks = await candidate(input);
		} catch {
			continue; // try the next candidate shape
		}
		const tools = extractToolMap(hooks);
		if (tools) return tools;
	}
	return undefined;
}

/**
 * Mirror the tool maps of every other plugin listed in `config.plugin`.
 *
 * Never throws: every failure is recorded in `failed` and the remaining
 * plugins are still processed. The returned `execute` functions are the
 * original closures from each plugin module; the caller supplies the
 * `ToolContext` (with a working `ask`) at call time.
 */
export async function mirrorPluginTools(
	config: Config | undefined,
	input: unknown,
	options?: MirrorPluginToolsOptions,
): Promise<MirrorResult> {
	const failed: Record<string, string> = {};
	const tools: MirroredTool[] = [];
	const seen = new Set<string>();

	const specs = (config?.plugin ?? [])
		.map((entry) =>
			typeof entry === "string"
				? entry
				: Array.isArray(entry)
					? entry[0]
					: undefined,
		)
		.filter((s): s is string => typeof s === "string" && s.length > 0);

	const cacheRoot = options?.cacheRoot ?? opencodePackagesRoot(homedir());

	for (const spec of specs) {
		if (SELF_SPECS.has(spec)) continue;
		const parsed = parsePluginSpec(spec);
		if (!parsed) {
			failed[spec] = "unsupported spec format";
			continue;
		}

		if (parsed.kind === "unsupported") {
			failed[spec] =
				"unsupported spec format (URL tarball specs are not mirrored)";
			continue;
		}
		let modulePath: string | undefined;
		if (parsed.kind === "path") {
			modulePath = parsed.path.startsWith("/") ? parsed.path : undefined;
			if (!modulePath || !existsSync(modulePath)) {
				failed[spec] = "plugin file not found";
				continue;
			}
		} else {
			const entry = resolveCacheEntry(cacheRoot, parsed);
			if (!entry) {
				failed[spec] = "not found in opencode package cache";
				continue;
			}
			const pkg = packageRoot(entry, parsed.name);
			if (!pkg) {
				failed[spec] = "package root not found in cache entry";
				continue;
			}
			// Resolve through the cache entry's package.json (main/exports)
			// so bundled plugins load exactly where their manifest says.
			const resolved = resolvePackageMain(entry, pkg, parsed.name);
			if (!resolved) {
				failed[spec] = "package entry point not found";
				continue;
			}
			modulePath = resolved;
		}

		if (!modulePath) {
			failed[spec] = "plugin module path not resolved";
			continue;
		}
		let toolMap: Record<string, ToolDefinition> | undefined;
		try {
			toolMap = await loadToolMap(modulePath, input);
		} catch (error) {
			failed[spec] = error instanceof Error ? error.message : String(error);
			continue;
		}
		if (!toolMap) {
			failed[spec] = "no tool map exported";
			continue;
		}

		for (const [id, def] of Object.entries(toolMap)) {
			if (seen.has(id)) continue;
			if (options?.exclude?.some((p) => matchPattern(p, id))) continue;
			if (
				options?.include &&
				options.include.length > 0 &&
				!options.include.some((p) => matchPattern(p, id))
			) {
				continue;
			}
			seen.add(id);
			tools.push({
				id,
				description: def.description,
				parameters: argsToJsonSchema(def.args),
				execute: def.execute,
				sourcePlugin: spec,
			});
		}
	}

	return { tools, failed };
}

/** Wildcard match: `*` = any sequence, otherwise literal. */
function matchPattern(pattern: string, value: string): boolean {
	if (pattern === "*") return true;
	if (!pattern.includes("*")) return pattern === value;
	const regex = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*");
	return new RegExp(`^${regex}$`).test(value);
}
