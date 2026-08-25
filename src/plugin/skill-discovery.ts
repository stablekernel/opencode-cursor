import {
	readdirSync,
	readFileSync,
	statSync,
	existsSync,
	realpathSync,
	mkdtempSync,
	mkdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import type { Dirent } from "node:fs";
import {
	join,
	relative,
	dirname,
	resolve as resolvePath,
	isAbsolute,
} from "node:path";
import { homedir, tmpdir } from "node:os";
import { execSync } from "node:child_process";
import type { Config } from "@opencode-ai/plugin";

/** A skill discovered from the filesystem, ready for permission filtering. */
export interface DiscoveredSkill {
	/** Skill id (the `name` field from frontmatter, also the directory name). */
	id: string;
	/** Human-readable name from frontmatter. */
	name: string;
	/** Description from frontmatter — used by Cursor for on-demand loading. */
	description: string;
	/** Absolute path to the skill's source directory (containing SKILL.md). */
	sourceDir: string;
	/** Relative paths of supporting files alongside SKILL.md (not SKILL.md itself). */
	files: string[];
}

/** Outcome of discovery + permission filtering. */
export interface ResolvedSkills {
	/** Skills permitted to mirror. */
	skills: DiscoveredSkill[];
	/** Skills withheld and why (for logging / user notification). */
	withheld: Array<{ id: string; reason: string }>;
}

/** Manual include/exclude override from plugin options. */
export interface SkillFilterOptions {
	include?: string[];
	exclude?: string[];
}

// --- Frontmatter parsing ---

/** Parse the small recognised frontmatter field set (name, description). */
function parseFrontmatter(content: string): {
	name?: string;
	description?: string;
} {
	if (!content.startsWith("---")) return {};
	const end = content.indexOf("\n---", 3);
	if (end === -1) return {};
	const frontmatter = content.slice(3, end);
	const result: { name?: string; description?: string } = {};
	for (const line of frontmatter.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const colon = trimmed.indexOf(":");
		if (colon === -1) continue;
		const key = trimmed.slice(0, colon).trim();
		let value = trimmed.slice(colon + 1).trim();
		// Strip surrounding quotes if present.
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		if (key === "name") result.name = value;
		else if (key === "description") result.description = value;
	}
	return result;
}

// --- Filesystem walk ---

/** Directory names under each config root that may contain skills. */
const SKILL_DIR_NAMES = ["skill", "skills"];

/** External (non-opencode) config roots that contain a `skills/` subdir. */
const EXTERNAL_DIR_NAMES = [".claude", ".agents"];

/**
 * Directory names, inside each opencode config root, that may hold file-based
 * plugins (`<name>.ts`). Skills bundled alongside file plugins live in sibling
 * skill dirs.
 */
const FILE_PLUGIN_DIR_NAMES = ["plugin", "plugins"];

/**
 * Directory names under each opencode plugin package root that may contain
 * skills. Both spellings are accepted because the repo's general skill scans
 * use `skill/` and `skills/` interchangeably.
 */
const PLUGIN_SKILL_DIR_NAMES = ["skills", "skill"];

/**
 * Resolve the root where opencode caches installed plugin packages: plugins
 * listed in `plugin: []` are installed here (npm or git specs). Skills bundled
 * inside such a package live under `node_modules/<pkg>/skills/`.
 *
 * Layout matches opencode's own cache location logic and mirrors the
 * existing helper in `version-check.ts` (`PLUGIN_CACHE_PATH`).
 */
export function opencodePackagesRoot(home = homedir()): string {
	if (process.platform === "win32") {
		return join(
			process.env.LocalAppData ?? join(home, "AppData", "Local"),
			"opencode",
			"cache",
			"packages",
		);
	}
	return join(
		process.env.XDG_CACHE_HOME ?? join(home, ".cache"),
		"opencode",
		"packages",
	);
}

/**
 * Collect the `skills/`-style directories inside a cache entry. Handles the
 * layouts observed in real caches:
 *
 * - flat packages:   `<entry>/node_modules/<pkg>/skills/`
 * - scoped packages: `<entry>/node_modules/@scope/<pkg>/skills/`
 * - git specs:       the spec dir nests (`spec@git+https:/github.com/owner/repo.git`)
 *                    before the `node_modules` install dir; found by a bounded
 *                    downward walk.
 *
 * Follows symlinks (real caches symlink the installed package into
 * node_modules). Never throws.
 */
export function pluginCacheSkillDirs(entry: string): string[] {
	const dirs: string[] = [];
	const visited = new Set<string>();

	/** Scan one `node_modules` dir: each child is a package root. */
	function scanNodeModules(nodeModules: string): void {
		let entries: Dirent[];
		try {
			entries = readdirSync(nodeModules, { withFileTypes: true });
		} catch {
			return;
		}
		for (const ent of entries) {
			if (ent.name === ".bin") continue;
			const fullPath = join(nodeModules, ent.name);
			if (entryKind(ent, fullPath) !== "dir") continue;
			if (ent.name.startsWith("@")) {
				// Scope dir: its children are package roots.
				scanNodeModules(fullPath);
				continue;
			}
			for (const skillName of SKILL_DIR_NAMES) {
				const candidate = join(fullPath, skillName);
				if (existsSync(candidate)) dirs.push(candidate);
			}
		}
	}

	/** Walk down from the entry dir (bounded) to find `node_modules`. */
	function findNodeModules(dir: string, depth: number): void {
		if (depth > 5) return;
		let realDir: string;
		try {
			realDir = realpathSync(dir);
		} catch {
			return;
		}
		if (visited.has(realDir)) return;
		visited.add(realDir);
		const nm = join(dir, "node_modules");
		if (existsSync(nm)) {
			scanNodeModules(nm);
			return;
		}
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const ent of entries) {
			const fullPath = join(dir, ent.name);
			if (entryKind(ent, fullPath) === "dir") {
				findNodeModules(fullPath, depth + 1);
			}
		}
	}

	findNodeModules(entry, 0);
	return dirs;
}

/**
 * Enumerate every plugin cache entry that may contain skills. Each entry is a
 * directory in the opencode packages root (npm specs like `name@latest` or
 * `@scope/name@latest`, git specs like `superpowers@git+https:...`, or bare
 * dirs). Top-level `node_modules` and package/lock files are skipped; the
 * remaining dirs are scanned for `skills/` regardless — non-plugin cache
 * entries (language servers, formatters) simply have none, and the README
 * documents that the cache also holds such tooling.
 */
export function pluginCacheEntries(root: string): string[] {
	let entries: Dirent[];
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return [];
	}
	const skip = new Set([
		"node_modules",
		"package.json",
		"package-lock.json",
		"bun.lock",
		"bun.lockb",
	]);
	const out: string[] = [];
	for (const ent of entries) {
		if (skip.has(ent.name)) continue;
		const full = join(root, ent.name);
		if (entryKind(ent, full) !== "dir") continue;
		out.push(full);
	}
	return out;
}

/**
 * Discover `skills/` dirs that ship inside opencode's plugin cache. Lowest
 * priority source: project/global/configured paths always win on duplicate ids
 * (first-wins ordering in {@link discoverSkills}).
 */
export function discoverPluginSkillDirs(
	cacheRoot?: string,
	home?: string,
): string[] {
	const root = cacheRoot ?? opencodePackagesRoot(home);
	if (!existsSync(root)) return [];
	const dirs: string[] = [];
	for (const entry of pluginCacheEntries(root)) {
		for (const skillDir of pluginCacheSkillDirs(entry)) {
			dirs.push(skillDir);
		}
	}
	return dirs;
}

/**
 * Find the git worktree root by walking up from `cwd`. Falls back to `cwd`
 * itself when not in a git repo (so a non-git project still discovers skills
 * in its own `.opencode/skills/`).
 */
function worktreeRoot(cwd: string): string {
	try {
		const root = execSync("git rev-parse --show-toplevel", {
			cwd,
			encoding: "utf8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 3000,
		}).trim();
		return root || cwd;
	} catch {
		return cwd;
	}
}

/** Walk up from `start` to `stop` (inclusive), yielding each directory. */
function* walkUp(start: string, stop: string): Generator<string> {
	let current = start;
	while (current) {
		yield current;
		if (current === stop) break;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
}

/** List immediate subdirectories of `dir` that contain a `SKILL.md`. */
function scanSkillDir(dir: string): Array<{ id: string; sourceDir: string }> {
	if (!existsSync(dir)) return [];
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const found: Array<{ id: string; sourceDir: string }> = [];
	for (const entry of entries) {
		// Symlinks are admitted here rather than filtered: `Dirent.isDirectory()`
		// is false for a symlink pointing at a directory, which would silently
		// drop skills linked in from a shared checkout. The `SKILL.md` check
		// below follows symlinks, so it rejects broken links and links to files.
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
		const skillDir = join(dir, entry.name);
		if (!existsSync(join(skillDir, "SKILL.md"))) continue;
		found.push({ id: entry.name, sourceDir: skillDir });
	}
	return found;
}

/**
 * Classify a directory entry, following symlinks. `Dirent` reports a symlink
 * as neither file nor directory, so symlinked supporting files would be lost
 * without this. Broken symlinks and non-regular targets resolve to "other".
 */
export function entryKind(
	entry: Dirent,
	fullPath: string,
): "dir" | "file" | "other" {
	if (entry.isDirectory()) return "dir";
	if (entry.isFile()) return "file";
	if (!entry.isSymbolicLink()) return "other";
	try {
		const target = statSync(fullPath);
		if (target.isDirectory()) return "dir";
		if (target.isFile()) return "file";
	} catch {
		// Broken symlink.
	}
	return "other";
}

/** Collect supporting files (relative paths) alongside SKILL.md in a skill dir. */
function collectFiles(sourceDir: string): string[] {
	const files: string[] = [];
	// Following symlinked directories admits cycles; track resolved paths.
	const visited = new Set<string>();
	function walk(dir: string, base: string) {
		let realDir: string;
		try {
			realDir = realpathSync(dir);
		} catch {
			return;
		}
		if (visited.has(realDir)) return;
		visited.add(realDir);
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const fullPath = join(dir, entry.name);
			const relPath = relative(base, fullPath);
			if (entry.name === "SKILL.md") continue;
			const kind = entryKind(entry, fullPath);
			if (kind === "dir") {
				walk(fullPath, base);
			} else if (kind === "file") {
				files.push(relPath);
			}
		}
	}
	walk(sourceDir, sourceDir);
	return files;
}

/** Load and parse a single skill from its source directory. */
function loadSkill(id: string, sourceDir: string): DiscoveredSkill | undefined {
	const skillMdPath = join(sourceDir, "SKILL.md");
	let content: string;
	try {
		content = readFileSync(skillMdPath, "utf8");
	} catch {
		return undefined;
	}
	const fm = parseFrontmatter(content);
	// Both name and description are required for the mirror — Cursor matches
	// skills by description, and the id must match the name for consistency.
	if (!fm.name || !fm.description) return undefined;
	return {
		id,
		name: fm.name,
		description: fm.description,
		sourceDir,
		files: collectFiles(sourceDir),
	};
}

/**
 * Expand a path from `skills.paths` the way opencode does: `~/` prefix →
 * home, relative paths → resolved against the project directory, absolute
 * paths used as-is. Returns undefined for empty input.
 */
function expandSkillPath(
	raw: string,
	cwd: string,
	home: string,
): string | undefined {
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	if (trimmed.startsWith("~/")) return join(home, trimmed.slice(2));
	if (isAbsolute(trimmed)) return trimmed;
	return resolvePath(cwd, trimmed);
}

/**
 * Collect skill directories that ship alongside file-based plugins — single
 * `.ts` files under `<root>/plugin/` or `<root>/plugins/` in each opencode
 * config root. A file plugin can bundle skills in a sibling `skills/` or
 * `skill/` dir (checked directly, not per-file) — see
 * {@link PLUGIN_SKILL_DIR_NAMES}.
 */
export function discoverFilePluginSkillDirs(roots: string[]): string[] {
	const dirs: string[] = [];
	for (const root of roots) {
		for (const sub of FILE_PLUGIN_DIR_NAMES) {
			const pluginDir = join(root, sub);
			if (!existsSync(pluginDir)) continue;
			for (const skillName of PLUGIN_SKILL_DIR_NAMES) {
				const skillDir = join(pluginDir, skillName);
				if (existsSync(skillDir)) dirs.push(skillDir);
			}
		}
	}
	return dirs;
}

/**
 * Locate plugin-bundled skill sources for the current install.
 *
 * Returns discovery options for {@link discoverSkills}: the opencode plugin
 * cache root, plus any config roots that actually contain file-plugin sibling
 * skill dirs (`skills/` or `skill/`, per {@link PLUGIN_SKILL_DIR_NAMES}).
 * File-plugin roots are checked cheaply (just an existence test per candidate)
 * so the default scan stays fast even when most users have no file-plugin
 * skills. Never throws — fs errors degrade to cache-only discovery.
 */
export function resolvePluginSkillSources(cwd?: string): {
	cacheRoot?: string;
	filePluginRoots?: string[];
} {
	const home = homedir();
	const cacheRoot = opencodePackagesRoot(home);
	let filePluginRoots: string[] = [];
	try {
		const candidates: string[] = [];
		const start = cwd ?? process.cwd();
		const stop = worktreeRoot(start);
		for (const ancestor of walkUp(start, stop)) {
			// File plugins live in the `.opencode` config root of each project.
			candidates.push(join(ancestor, ".opencode"));
		}
		const xdgConfig = process.env["XDG_CONFIG_HOME"] || join(home, ".config");
		candidates.push(join(xdgConfig, "opencode"), home);
		filePluginRoots = discoverFilePluginSkillDirs(candidates)
			.map((dir) => dirname(dirname(dir)))
			.filter((v, i, arr) => arr.indexOf(v) === i);
	} catch {
		// Degrade to cache-only discovery.
	}
	return { cacheRoot, filePluginRoots };
}

/**
 * Discover skills from the filesystem, using a deterministic resolution
 * order that prioritises specificity: project beats global, nearer beats
 * farther, `.opencode` beats `.claude`/`.agents`.
 *
 * Scan order (first wins on duplicate id — a skill already seen is kept,
 * later duplicates are skipped):
 *  1. Project `.opencode/skill/`, `.opencode/skills/` walk-up (near→far)
 *  2. Project `.claude/skills/`, `.agents/skills/` walk-up (near→far)
 *  3. Global `~/.config/opencode/skill/`, `~/.config/opencode/skills/`
 *  4. Global `~/.claude/skills/`, `~/.agents/skills/`
 *  5. `~/.opencode/skill/`, `~/.opencode/skills/` (if `~/.opencode` exists)
 *  6. Extra paths from `config.skills.paths`
 *  7. Skills bundled inside installed opencode plugins — the opencode plugin
 *     cache (`opencodePackagesRoot()`), plus file-plugin sibling dirs
 *     (`~/.config/opencode/plugins/` etc). Lowest priority.
 *
 * This differs from opencode's own resolution, which loads concurrently with
 * unbounded concurrency (making "last wins" non-deterministic). We use
 * first-wins for a deterministic, specificity-ordered mirror.
 *
 * `extraPaths` corresponds to opencode's `config.skills.paths` — additional
 * directories to scan for skills. Paths are expanded: `~/` → home, relative
 * → resolved against `cwd`, absolute used as-is. Non-existent directories
 * are silently skipped (matching opencode's behaviour).
 */
export function discoverSkills(
	cwd: string,
	extraPaths?: string[],
	options?: { cacheRoot?: string; filePluginRoots?: string[] },
): DiscoveredSkill[] {
	const home = homedir();
	const xdgConfig = process.env["XDG_CONFIG_HOME"] || join(home, ".config");
	const stop = worktreeRoot(cwd);

	// Build the scan list in specificity order (first wins).
	const scanRoots: string[] = [];

	// 1. Project .opencode walk-up (near→far)
	for (const ancestor of walkUp(cwd, stop)) {
		for (const sub of SKILL_DIR_NAMES) {
			scanRoots.push(join(ancestor, ".opencode", sub));
		}
	}

	// 2. Project external walk-up (near→far)
	for (const ancestor of walkUp(cwd, stop)) {
		for (const ext of EXTERNAL_DIR_NAMES) {
			scanRoots.push(join(ancestor, ext, "skills"));
		}
	}

	// 3. Global opencode
	for (const sub of SKILL_DIR_NAMES) {
		scanRoots.push(join(xdgConfig, "opencode", sub));
	}

	// 4. Global external
	for (const ext of EXTERNAL_DIR_NAMES) {
		scanRoots.push(join(home, ext, "skills"));
	}

	// 5. ~/.opencode (if it exists)
	const tildeOpencode = join(home, ".opencode");
	if (existsSync(tildeOpencode)) {
		for (const sub of SKILL_DIR_NAMES) {
			scanRoots.push(join(tildeOpencode, sub));
		}
	}

	// 6. Extra paths from config.skills.paths
	if (extraPaths) {
		for (const raw of extraPaths) {
			const expanded = expandSkillPath(raw, cwd, home);
			if (!expanded) continue;
			if (!existsSync(expanded)) continue;
			scanRoots.push(expanded);
		}
	}

	// 7. Plugin-bundled skills (lowest priority): the opencode plugin cache,
	// then sibling skill dirs of file-based plugins. File-plugin roots follow
	// the same specificity order as other project dirs (walk-up near→far, then
	// global), so a project's local file plugins are found before global ones.
	for (const dir of discoverPluginSkillDirs(options?.cacheRoot, home)) {
		scanRoots.push(dir);
	}
	const filePluginRoots = options?.filePluginRoots;
	if (filePluginRoots) {
		for (const dir of discoverFilePluginSkillDirs(filePluginRoots)) {
			scanRoots.push(dir);
		}
	} else {
		// Project config roots (near→far), then global: same specificity order
		// as the other project skill scans.
		for (const ancestor of walkUp(cwd, stop)) {
			for (const dir of discoverFilePluginSkillDirs([
				join(ancestor, ".opencode"),
			])) {
				scanRoots.push(dir);
			}
		}
		for (const dir of discoverFilePluginSkillDirs([
			join(xdgConfig, "opencode"),
			home,
		])) {
			scanRoots.push(dir);
		}
	}

	// Scan in order, first wins on duplicate id (skip if already seen).
	const byId = new Map<string, DiscoveredSkill>();
	for (const dir of scanRoots) {
		const found = scanSkillDir(dir);
		for (const { id, sourceDir } of found) {
			if (byId.has(id)) continue;
			const skill = loadSkill(id, sourceDir);
			if (skill) byId.set(id, skill);
		}
	}

	return Array.from(byId.values());
}

// --- Permission filtering ---

/** Wildcard pattern match supporting `*` (any sequence) and literal text. */
function wildcardMatch(pattern: string, value: string): boolean {
	if (pattern === "*") return true;
	if (!pattern.includes("*")) return pattern === value;
	// Convert glob to regex: escape everything except *, replace * with .*
	const regex = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*");
	return new RegExp(`^${regex}$`).test(value);
}

/** Action for a skill under the map-form permission config. */
type SkillAction = "allow" | "deny" | "ask";

/** Resolve the action for a skill id from the map-form `skill` permission rule. */
function resolveMapPermission(
	skillPerm: unknown,
	skillId: string,
): SkillAction | undefined {
	if (typeof skillPerm === "string") {
		return skillPerm as SkillAction;
	}
	if (typeof skillPerm !== "object" || skillPerm === null) return undefined;
	const map = skillPerm as Record<string, string>;
	// Last-matching-pattern wins (iterate in insertion order).
	let action: SkillAction | undefined;
	for (const [pattern, value] of Object.entries(map)) {
		if (wildcardMatch(pattern, skillId)) {
			action = value as SkillAction;
		}
	}
	return action;
}

/** Resolve the action for a skill id from the rule-array permission config. */
function resolveRuleArrayPermission(
	rules: Array<{ permission: string; pattern: string; action: string }>,
	skillId: string,
): SkillAction | undefined {
	// Last-matching-rule wins.
	let action: SkillAction | undefined;
	for (const rule of rules) {
		if (rule.permission !== "skill") continue;
		if (wildcardMatch(rule.pattern, skillId)) {
			action = rule.action as SkillAction;
		}
	}
	return action;
}

/**
 * Filter discovered skills through opencode's live permission config and the
 * plugin's manual include/exclude override.
 *
 * - `deny` → excluded entirely.
 * - `ask` → excluded (the ask prompt can't be enforced across the Cursor
 *   boundary). Logged as withheld.
 * - `allow` → included.
 * - No permission config for skills → all included (default allow).
 *
 * Manual `include`/`exclude` from plugin options takes precedence over
 * permission config: `exclude` always drops, `include` always keeps (even if
 * permission says deny — the user explicitly asked for it).
 */
export function filterSkills(
	skills: DiscoveredSkill[],
	config: Config | undefined,
	options?: SkillFilterOptions,
): ResolvedSkills {
	const include = options?.include ?? [];
	const exclude = options?.exclude ?? [];
	const matchesAny = (patterns: string[], id: string) =>
		patterns.some((pattern) => wildcardMatch(pattern, id));

	// Extract skill permission config from both forms.
	const permission = config?.permission as Record<string, unknown> | undefined;
	const mapSkillPerm = permission?.["skill"];
	const ruleArray = Array.isArray(permission?.["permission"])
		? (permission!["permission"] as Array<{
				permission: string;
				pattern: string;
				action: string;
			}>)
		: undefined;

	// Also check the V2 PermissionRuleset form (config.permission as array).
	const v2Ruleset = Array.isArray(config?.permission)
		? (config!.permission as Array<{
				permission: string;
				pattern: string;
				action: string;
			}>)
		: undefined;

	const permitted: DiscoveredSkill[] = [];
	const withheld: Array<{ id: string; reason: string }> = [];

	for (const skill of skills) {
		// Manual exclude always wins.
		if (matchesAny(exclude, skill.id)) {
			withheld.push({ id: skill.id, reason: "excluded by plugin options" });
			continue;
		}
		// Manual include always wins.
		if (include.length > 0 && matchesAny(include, skill.id)) {
			permitted.push(skill);
			continue;
		}
		// If include list is specified and this skill isn't on it, skip.
		if (include.length > 0 && !matchesAny(include, skill.id)) {
			withheld.push({
				id: skill.id,
				reason: "not in plugin include list",
			});
			continue;
		}

		// Resolve permission action.
		let action: SkillAction | undefined;
		if (v2Ruleset) {
			action = resolveRuleArrayPermission(v2Ruleset, skill.id);
		}
		if (action === undefined && ruleArray) {
			action = resolveRuleArrayPermission(ruleArray, skill.id);
		}
		if (action === undefined && mapSkillPerm !== undefined) {
			action = resolveMapPermission(mapSkillPerm, skill.id);
		}

		// Default to allow when no permission config touches this skill.
		if (action === undefined || action === "allow") {
			permitted.push(skill);
		} else if (action === "deny") {
			withheld.push({ id: skill.id, reason: "denied by permission config" });
		} else if (action === "ask") {
			withheld.push({
				id: skill.id,
				reason:
					"ask-permissioned skills are withheld (the ask prompt can't cross the Cursor boundary)",
			});
		}
	}

	return { skills: permitted, withheld };
}

/**
 * A skill as reported by opencode's live `app.skills` endpoint.
 * `location` is the absolute path of the skill's SKILL.md.
 */
export interface LiveSkill {
	name: string;
	description?: string;
	location: string;
	/**
	 * The skill's full body. Present for content-only skills (e.g. opencode's
	 * `<built-in>` skills, which have no on-disk SKILL.md).
	 */
	content?: string;
}

/**
 * Scratch root holding materialised copies of skills that only exist in
 * opencode's live inventory (no on-disk SKILL.md — e.g. opencode's own
 * `<built-in>` skills, whose content is registered in code). Stable across
 * calls so `skillSetHash` mtime checks don't churn per turn; wiped on exit.
 */
let liveScratchRoot: string | undefined;
let liveScratchCleanupRegistered = false;

/** Test hook: drop the scratch root so tests don't share state. */
export function resetLiveSkillScratch(): void {
	const root = liveScratchRoot;
	if (root) {
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {
			// best effort
		}
	}
	liveScratchRoot = undefined;
}

function liveScratchDir(): string {
	if (!liveScratchRoot) {
		liveScratchRoot = mkdtempSync(join(tmpdir(), "opencode-cursor-skills-"));
		if (!liveScratchCleanupRegistered) {
			liveScratchCleanupRegistered = true;
			const rootAtExit = liveScratchRoot;
			process.once("exit", () => {
				rmSync(rootAtExit, { recursive: true, force: true });
			});
		}
	}
	return liveScratchRoot;
}

/**
 * Convert live `app.skills` entries into {@link DiscoveredSkill}s.
 *
 * Disk-backed entries point at the skill's on-disk directory (derived from
 * `location`); entries whose location isn't resolvable are skipped — the
 * filesystem scan already covers anything reachable.
 *
 * Content-only entries (no on-disk SKILL.md — opencode's `<built-in>` skills
 * and anything else opencode serves from memory) are materialised into a
 * scratch dir so the mirror can stamp and copy them like any other skill.
 * The rewritten file carries frontmatter (the live `description`) + the
 * live `content` body, keeping the mirror in sync with opencode's version.
 */
export function liveSkillsToDiscovered(live: LiveSkill[]): DiscoveredSkill[] {
	const out: DiscoveredSkill[] = [];
	for (const skill of live) {
		if (!skill.location || !skill.name) continue;
		const sourceDir = skill.location.endsWith("SKILL.md")
			? dirname(skill.location)
			: skill.location;
		if (existsSync(join(sourceDir, "SKILL.md"))) {
			const loaded = loadSkill(skill.name, sourceDir);
			if (loaded) out.push(loaded);
			continue;
		}
		// Not on disk: materialise if opencode gave us content.
		if (!skill.content) continue;
		const scratchDir = join(liveScratchDir(), skill.name);
		const scratchMd = join(scratchDir, "SKILL.md");
		// Rewrite only when the content or description actually changed, so
		// per-turn calls don't touch mtimes and invalidate the skill hash.
		let needsWrite = true;
		if (existsSync(scratchMd)) {
			try {
				const existing = readFileSync(scratchMd, "utf8");
				if (existing === renderLiveSkillMd(skill)) needsWrite = false;
			} catch {
				// unreadable → rewrite
			}
		}
		if (needsWrite) {
			try {
				mkdirSync(scratchDir, { recursive: true });
				writeFileSync(scratchMd, renderLiveSkillMd(skill), "utf8");
			} catch {
				continue; // scratch fs unavailable — skip this skill
			}
		}
		const loaded = loadSkill(skill.name, scratchDir);
		if (loaded) out.push(loaded);
	}
	return out;
}

/** Render a live (content-only) skill as a stamped SKILL.md. */
function renderLiveSkillMd(skill: LiveSkill): string {
	// YAML: quote the description to survive colons/quotes inside it.
	const escaped = (skill.description ?? "").replace(/"/g, '\\"');
	const body = skill.content ?? "";
	const separator = body.startsWith("\n") ? "" : "\n";
	return `---\nname: ${skill.name}\ndescription: "${escaped}"\n---\n${separator}${body}`;
}

/**
 * Discover and filter skills in one call. This is the main entry point for the
 * plugin's config and chat.params hooks. Never throws — fs errors degrade to
 * an empty skill list.
 *
 * `config.skills.paths` is extracted and passed to {@link discoverSkills} as
 * `extraPaths`, so skills configured via the `skills.paths` config option are
 * included in the mirror (lowest priority, first-wins).
 *
 * When `liveSkills` is supplied (from opencode's `app.skills` endpoint), those
 * skills are merged in at the LOWEST priority — the filesystem scan wins on
 * duplicate ids, but anything opencode knows about that the scan missed
 * (e.g. skills sourced from locations this mirror doesn't scan) still reaches
 * the Cursor agent.
 */
export function resolveSkills(
	cwd: string,
	config?: Config,
	options?: SkillFilterOptions,
	discoveryOptions?: {
		cacheRoot?: string;
		filePluginRoots?: string[];
		liveSkills?: LiveSkill[];
	},
): ResolvedSkills {
	// SAFETY: `config` at runtime is the live opencode config JSON returned by
	// client.config.get(); its shape always carries a `skills` object when the
	// user configured one. The V1 Config type just omits that field, so we
	// widen it here. Access is optional-chain guarded below.
	const skillsConfig = config as unknown as
		| { skills?: { paths?: string[] } }
		| undefined;
	const extraPaths = skillsConfig?.skills?.paths;

	let discovered: DiscoveredSkill[];
	try {
		discovered = discoverSkills(cwd, extraPaths, discoveryOptions);
	} catch {
		discovered = [];
	}
	if (discoveryOptions?.liveSkills?.length) {
		const seen = new Set(discovered.map((s) => s.id));
		for (const skill of liveSkillsToDiscovered(discoveryOptions.liveSkills)) {
			if (seen.has(skill.id)) continue;
			seen.add(skill.id);
			discovered.push(skill);
		}
	}
	return filterSkills(discovered, config, options);
}

/**
 * A stable hash of the resolved skill set, used to skip re-materialisation
 * when nothing changed between turns. Based on skill ids + source dirs + file
 * mtimes so content changes are detected.
 */
export function skillSetHash(skills: DiscoveredSkill[]): string {
	const parts = skills.map((s) => {
		const files = ["SKILL.md", ...s.files].map((file) => {
			try {
				const stat = statSync(join(s.sourceDir, file));
				return `${file}:${stat.mtimeMs}:${stat.size}`;
			} catch {
				return `${file}:missing`;
			}
		});
		files.sort();
		return `${s.id}:${s.sourceDir}:${files.join(",")}`;
	});
	parts.sort();
	return parts.join("|");
}
