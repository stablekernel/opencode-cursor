import {
	readdirSync,
	readFileSync,
	statSync,
	existsSync,
	realpathSync,
} from "node:fs";
import type { Dirent } from "node:fs";
import { join, relative, dirname, resolve as resolvePath, isAbsolute } from "node:path";
import { homedir } from "node:os";
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
function parseFrontmatter(
	content: string,
): { name?: string; description?: string } {
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
function* walkUp(
	start: string,
	stop: string,
): Generator<string> {
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
function scanSkillDir(
	dir: string,
): Array<{ id: string; sourceDir: string }> {
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
function loadSkill(
	id: string,
	sourceDir: string,
): DiscoveredSkill | undefined {
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
function expandSkillPath(raw: string, cwd: string, home: string): string | undefined {
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	if (trimmed.startsWith("~/")) return join(home, trimmed.slice(2));
	if (isAbsolute(trimmed)) return trimmed;
	return resolvePath(cwd, trimmed);
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
 *  6. Extra paths from `config.skills.paths` (lowest priority, first-wins)
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
): DiscoveredSkill[] {
	const home = homedir();
	const xdgConfig =
		process.env["XDG_CONFIG_HOME"] || join(home, ".config");
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

	// 6. Extra paths from config.skills.paths (lowest priority)
	if (extraPaths) {
		for (const raw of extraPaths) {
			const expanded = expandSkillPath(raw, cwd, home);
			if (!expanded) continue;
			if (!existsSync(expanded)) continue;
			scanRoots.push(expanded);
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
	const regex = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
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
 * Discover and filter skills in one call. This is the main entry point for the
 * plugin's config and chat.params hooks. Never throws — fs errors degrade to
 * an empty skill list.
 *
 * `config.skills.paths` is extracted and passed to {@link discoverSkills} as
 * `extraPaths`, so skills configured via the `skills.paths` config option are
 * included in the mirror (lowest priority, first-wins).
 */
export function resolveSkills(
	cwd: string,
	config?: Config,
	options?: SkillFilterOptions,
): ResolvedSkills {
	// Extract skills.paths from the config (untyped — the V1 Config type
	// doesn't include the `skills` field, but the live config returned by
	// client.config.get() does).
	const skillsConfig = config as unknown as
		| { skills?: { paths?: string[] } }
		| undefined;
	const extraPaths = skillsConfig?.skills?.paths;

	let discovered: DiscoveredSkill[];
	try {
		discovered = discoverSkills(cwd, extraPaths);
	} catch {
		discovered = [];
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
