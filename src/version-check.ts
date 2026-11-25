import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { get } from "node:https";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import semver from "semver";

/**
 * Inlined by tsup's `define` option in the published bundle (see
 * tsup.config.ts). In the bundle, a relative require of `../package.json`
 * would resolve inside `dist/` where no package.json exists, so the version
 * must be baked in at build time. When running un-bundled (tests against
 * `src/`), this stays undefined and `getLocalVersion` falls back to reading
 * package.json.
 */
declare const __PKG_VERSION__: string | undefined;

const PACKAGE_NAME = "@stablekernel/opencode-cursor";
const REGISTRY_URL = `https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}/latest`;

/**
 * The directory opencode caches npm/git plugin installs under. v1 used
 * `cache/packages`; v2 uses `cache/npm` and nests a content-hash directory
 * below each `<spec>`, so callers remove the spec dir, not a hash dir.
 */
const PLUGINS_CACHE_ROOT =
	process.platform === "win32"
		? join(process.env.LocalAppData ?? join(homedir(), "AppData", "Local"), "opencode", "cache", "npm")
		: join(process.env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache"), "opencode", "npm");

/**
 * The path where opencode caches the installed plugin package.
 * Used by `warnIfStale` (to build the removal command) and by the
 * `cursor_update_plugin` tool (to actually clear the cache) — single source
 * of truth so both stay in sync.
 */
export const PLUGIN_CACHE_PATH = join(PLUGINS_CACHE_ROOT, `${PACKAGE_NAME}@latest`);

/**
 * True when this copy runs from a checkout instead of opencode's cache (a
 * local-path plugin entry). opencode excludes local plugins from
 * `opencode plugin update`, so update checks must not offer a cache clear.
 */
export function isLocalInstall(): boolean {
	// Tests and CI run from source; `OPENCODE_CURSOR_CACHE_INSTALL=1` simulates
	// a cache install so the npm-only paths stay exercised.
	if (process.env["OPENCODE_CURSOR_CACHE_INSTALL"] === "1") return false;
	return !fileURLToPath(import.meta.url).startsWith(PLUGINS_CACHE_ROOT + sep);
}

/**
 * A `file://` specifier for this checkout's provider entry, for opencode to
 * load instead of the published package. Undefined for cache installs.
 */
export function localProviderSpec(): string | undefined {
	if (!isLocalInstall()) return undefined;
	let dir = dirname(fileURLToPath(import.meta.url));
	for (let depth = 0; depth < 4; depth++) {
		if (existsSync(join(dir, "package.json"))) {
			return pathToFileURL(join(dir, "dist", "provider", "index.js")).href;
		}
		dir = dirname(dir);
	}
	return undefined;
}
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Failed fetches are retried sooner than successful ones so a transient
// network error doesn't suppress the check for a full day.
const FAILURE_TTL_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5000;

interface VersionCheckCache {
	checkedAt: number;
	latest: string | undefined;
}

function cacheDir(): string {
	const base =
		process.env.XDG_CACHE_HOME?.trim() ||
		(homedir() ? join(homedir(), ".cache") : tmpdir());
	return join(base, "opencode-cursor");
}

function cacheFile(): string {
	return join(cacheDir(), "version-check.json");
}

function readCache(): VersionCheckCache | undefined {
	try {
		const parsed = JSON.parse(readFileSync(cacheFile(), "utf8")) as VersionCheckCache;
		if (typeof parsed.checkedAt === "number") return parsed;
	} catch {
		// ignore
	}
	return undefined;
}

function writeCache(latest: string | undefined): void {
	try {
		mkdirSync(cacheDir(), { recursive: true });
		writeFileSync(
			cacheFile(),
			JSON.stringify({ checkedAt: Date.now(), latest }),
			"utf8",
		);
	} catch {
		// Best-effort; never block plugin init.
	}
}

/** Remove the on-disk version-check cache so the next startup re-fetches from npm. */
export function clearVersionCache(): void {
	try {
		rmSync(cacheFile(), { force: true });
	} catch {
		// Best-effort.
	}
}

export function getLocalVersion(): string | undefined {
	// Build-time inlined version (published bundle path).
	if (typeof __PKG_VERSION__ === "string") return __PKG_VERSION__;
	// Un-bundled fallback: resolve package.json relative to this source file.
	try {
		const require = createRequire(import.meta.url);
		const pkg = require("../package.json") as { version: string };
		return pkg.version;
	} catch {
		return undefined;
	}
}

function fetchLatestVersion(): Promise<string | undefined> {
	return new Promise((resolve) => {
		const req = get(
			REGISTRY_URL,
			{ headers: { Accept: "application/json", Connection: "close" } },
			(res) => {
				if (res.statusCode !== 200) {
					res.resume();
					resolve(undefined);
					return;
				}
				let body = "";
				res.setEncoding("utf8");
				res.on("data", (chunk: string) => {
					body += chunk;
				});
				res.on("end", () => {
					try {
						const parsed = JSON.parse(body) as { version?: string };
						resolve(parsed.version);
					} catch {
						resolve(undefined);
					}
				});
				res.on("error", () => resolve(undefined));
			},
		);
		req.setTimeout(REQUEST_TIMEOUT_MS, () => {
			req.destroy();
			resolve(undefined);
		});
		req.on("error", () => resolve(undefined));
	});
}

/** Return the cached latest version if fresh, else fetch from npm. */
export async function getLatestVersion(): Promise<string | undefined> {
	const cached = readCache();
	if (cached) {
		// Successful lookups are trusted for 24h; failures only briefly.
		const ttl = cached.latest ? CHECK_INTERVAL_MS : FAILURE_TTL_MS;
		if (Date.now() - cached.checkedAt < ttl) return cached.latest;
	}
	const latest = await fetchLatestVersion();
	writeCache(latest);
	return latest;
}

/**
 * Check whether this installed plugin is older than the registry's `latest`
 * tag. opencode resolves `@latest` once and then never reinstalls the plugin,
 * so users can silently stay on old versions.
 *
 * The registry fetch is throttled to once per 24h via an on-disk cache.
 * Staleness is surfaced via the UI toast (plugin/index.ts); no terminal output
 * is emitted. Set CI or NO_UPDATE_NOTIFIER to skip the check entirely.
 *
 * @param prefetchedLatest - Optional already-resolved latest version string.
 *   Pass this when the caller has already awaited `getLatestVersion()` so the
 *   registry is only fetched once per startup rather than twice.
 */
export async function warnIfStale(prefetchedLatest?: string): Promise<void> {
	if (process.env.CI || process.env.NO_UPDATE_NOTIFIER) return;
	// A local checkout is not the thing npm's `latest` describes; updating it
	// is a `git pull`, and the update tool says so.
	if (isLocalInstall()) return;

	const local = getLocalVersion();
	if (!local || !semver.valid(local)) return;
	const latest = prefetchedLatest ?? (await getLatestVersion());
	if (!latest || !semver.valid(latest)) return;
	if (!semver.gt(latest, local)) return;

	// Update notice is surfaced via the UI toast (plugin/index.ts); no
	// terminal output needed.
}
