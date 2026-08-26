import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	rmSync,
	existsSync,
	symlinkSync,
	readFileSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

// Mock homedir so global skill discovery doesn't pick up real skills from
// the developer's machine. Use a temp dir that's cleaned up after each test.
const fakeHome = mkdtempSync(join(tmpdir(), "cursor-skill-home-"));
vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	return { ...actual, homedir: () => fakeHome };
});

// SAFETY: XDG env vars leak past the fakeHome mock (the discovery code
// prefers `process.env.XDG_CONFIG_HOME` over the mocked homedir), so any
// real XDG_* on the host/CI would contaminate these tests. Point them at
// per-file fake dirs for the duration of this worker.
const realXdgConfig = process.env["XDG_CONFIG_HOME"];
const realXdgCache = process.env["XDG_CACHE_HOME"];
process.env["XDG_CONFIG_HOME"] = join(fakeHome, ".config");
process.env["XDG_CACHE_HOME"] = join(fakeHome, ".cache");
afterAll(() => {
	if (realXdgConfig === undefined) delete process.env["XDG_CONFIG_HOME"];
	else process.env["XDG_CONFIG_HOME"] = realXdgConfig;
	if (realXdgCache === undefined) delete process.env["XDG_CACHE_HOME"];
	else process.env["XDG_CACHE_HOME"] = realXdgCache;
});

const {
	discoverSkills,
	filterSkills,
	resolveSkills,
	skillSetHash,
	resetLiveSkillScratch,
} = await import("../src/plugin/skill-discovery.js");
import type { DiscoveredSkill } from "../src/plugin/skill-discovery.js";
import type { Config } from "@opencode-ai/plugin";

const dirs: string[] = [];
function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), "cursor-skill-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	// Drop the content-only live-skill scratch root between tests.
	resetLiveSkillScratch();
	for (const d of dirs.splice(0)) {
		rmSync(d, { recursive: true, force: true });
	}
	// Also clean up any skills written to the mocked fakeHome.
	const fakeHomeSkills = join(fakeHome, ".config", "opencode", "skills");
	if (existsSync(fakeHomeSkills)) {
		rmSync(fakeHomeSkills, { recursive: true, force: true });
	}
	const fakeHomeMySkills = join(fakeHome, "my-skills");
	if (existsSync(fakeHomeMySkills)) {
		rmSync(fakeHomeMySkills, { recursive: true, force: true });
	}
	// Clean up plugin-cache / file-plugin fixture dirs under fakeHome.
	for (const sub of [
		join(".cache", "opencode", "packages"),
		join(".config", "opencode", "plugins"),
	]) {
		const p = join(fakeHome, sub);
		if (existsSync(p)) rmSync(p, { recursive: true, force: true });
	}
});

/** Write a skill directory with SKILL.md frontmatter. */
function writeSkill(
	base: string,
	id: string,
	fm: { name: string; description: string },
	body = "Skill content.",
	extra?: Record<string, string>,
): string {
	const dir = join(base, id);
	mkdirSync(dir, { recursive: true });
	const content = `---\nname: ${fm.name}\ndescription: ${fm.description}\n---\n\n${body}\n`;
	writeFileSync(join(dir, "SKILL.md"), content, "utf8");
	if (extra) {
		for (const [path, content] of Object.entries(extra)) {
			const fullPath = join(dir, path);
			mkdirSync(join(fullPath, ".."), { recursive: true });
			writeFileSync(fullPath, content, "utf8");
		}
	}
	return dir;
}

describe("discoverSkills", () => {
	it("discovers a project skill from .opencode/skills/", () => {
		const cwd = tmp();
		writeSkill(join(cwd, ".opencode", "skills"), "my-skill", {
			name: "my-skill",
			description: "Does a thing.",
		});
		const skills = discoverSkills(cwd);
		expect(skills).toHaveLength(1);
		expect(skills[0]!.id).toBe("my-skill");
		expect(skills[0]!.name).toBe("my-skill");
		expect(skills[0]!.description).toBe("Does a thing.");
	});

	it("discovers from singular .opencode/skill/", () => {
		const cwd = tmp();
		writeSkill(join(cwd, ".opencode", "skill"), "singular", {
			name: "singular",
			description: "Singular dir.",
		});
		const skills = discoverSkills(cwd);
		expect(skills.find((s) => s.id === "singular")).toBeDefined();
	});

	it("discovers from .claude/skills/ and .agents/skills/", () => {
		const cwd = tmp();
		writeSkill(join(cwd, ".claude", "skills"), "claude-skill", {
			name: "claude-skill",
			description: "Claude skill.",
		});
		writeSkill(join(cwd, ".agents", "skills"), "agent-skill", {
			name: "agent-skill",
			description: "Agent skill.",
		});
		const skills = discoverSkills(cwd);
		expect(skills.find((s) => s.id === "claude-skill")).toBeDefined();
		expect(skills.find((s) => s.id === "agent-skill")).toBeDefined();
	});

	it("project .opencode beats global .config/opencode on duplicate id", () => {
		const cwd = tmp();
		// We can't easily test global without mocking homedir, so test
		// project-level precedence: .opencode beats .claude for the same id.
		writeSkill(join(cwd, ".claude", "skills"), "shared", {
			name: "shared",
			description: "Claude version.",
		});
		writeSkill(join(cwd, ".opencode", "skills"), "shared", {
			name: "shared",
			description: "Opencode version.",
		});
		const skills = discoverSkills(cwd);
		const shared = skills.find((s) => s.id === "shared");
		expect(shared).toBeDefined();
		expect(shared!.description).toBe("Opencode version.");
	});

	it("project skill beats global skill with the same id (first wins)", () => {
		// This test would have caught the original "later wins" bug, where
		// global ~/.opencode (scanned last) would override a project skill.
		const cwd = tmp();
		// Project skill.
		writeSkill(join(cwd, ".opencode", "skills"), "global-vs-proj", {
			name: "global-vs-proj",
			description: "Project version.",
		});
		// Global skill with the same id (in the mocked fakeHome).
		writeSkill(
			join(fakeHome, ".config", "opencode", "skills"),
			"global-vs-proj",
			{
				name: "global-vs-proj",
				description: "Global version.",
			},
		);
		const skills = discoverSkills(cwd);
		const skill = skills.find((s) => s.id === "global-vs-proj");
		expect(skill).toBeDefined();
		expect(skill!.description).toBe("Project version.");
	});

	it("nearer up the tree beats farther (first wins, specificity-ordered)", () => {
		const root = tmp();
		const sub = join(root, "subdir");
		mkdirSync(sub, { recursive: true });
		// Near skill scanned first → near wins (more specific location).
		writeSkill(join(sub, ".opencode", "skills"), "dup", {
			name: "dup",
			description: "Near version.",
		});
		writeSkill(join(root, ".opencode", "skills"), "dup", {
			name: "dup",
			description: "Far version.",
		});
		// Need git init so worktreeRoot detects the root.
		execSync("git init", { cwd: root });
		const skills = discoverSkills(sub);
		const dup = skills.find((s) => s.id === "dup");
		expect(dup).toBeDefined();
		expect(dup!.description).toBe("Near version.");
	});

	it("skips skills missing name or description", () => {
		const cwd = tmp();
		const dir = join(cwd, ".opencode", "skills", "no-name");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "SKILL.md"),
			"---\ndescription: Has desc but no name.\n---\n\nBody.\n",
			"utf8",
		);
		const dir2 = join(cwd, ".opencode", "skills", "no-desc");
		mkdirSync(dir2, { recursive: true });
		writeFileSync(
			join(dir2, "SKILL.md"),
			"---\nname: no-desc\n---\n\nBody.\n",
			"utf8",
		);
		const dir3 = join(cwd, ".opencode", "skills", "valid");
		mkdirSync(dir3, { recursive: true });
		writeFileSync(
			join(dir3, "SKILL.md"),
			"---\nname: valid\ndescription: Valid.\n---\n\nBody.\n",
			"utf8",
		);
		const skills = discoverSkills(cwd);
		expect(skills.map((s) => s.id)).toEqual(["valid"]);
	});

	it("handles malformed frontmatter gracefully", () => {
		const cwd = tmp();
		const dir = join(cwd, ".opencode", "skills", "broken");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), "No frontmatter at all.\n", "utf8");
		const skills = discoverSkills(cwd);
		expect(skills).toHaveLength(0);
	});

	it("collects supporting files alongside SKILL.md", () => {
		const cwd = tmp();
		writeSkill(
			join(cwd, ".opencode", "skills"),
			"with-files",
			{ name: "with-files", description: "Has files." },
			"Body.",
			{
				"reference.md": "# Reference",
				"templates/tmpl.txt": "Template content",
			},
		);
		const skills = discoverSkills(cwd);
		const skill = skills[0]!;
		expect(skill.files).toContain("reference.md");
		expect(skill.files).toContain("templates/tmpl.txt");
		expect(skill.files).not.toContain("SKILL.md");
	});

	it("handles a non-git directory (worktree root = cwd)", () => {
		const cwd = tmp();
		writeSkill(join(cwd, ".opencode", "skills"), "no-git", {
			name: "no-git",
			description: "No git.",
		});
		const skills = discoverSkills(cwd);
		expect(skills.find((s) => s.id === "no-git")).toBeDefined();
	});

	it("discovers skills from extraPaths (config.skills.paths)", () => {
		const cwd = tmp();
		const extraDir = tmp();
		writeSkill(extraDir, "extra-skill", {
			name: "extra-skill",
			description: "From extra paths.",
		});
		const skills = discoverSkills(cwd, [extraDir]);
		expect(skills.find((s) => s.id === "extra-skill")).toBeDefined();
	});

	it("extraPaths skills are lowest priority (project wins on duplicate)", () => {
		const cwd = tmp();
		const extraDir = tmp();
		writeSkill(join(cwd, ".opencode", "skills"), "dup", {
			name: "dup",
			description: "Project version.",
		});
		writeSkill(extraDir, "dup", {
			name: "dup",
			description: "Extra path version.",
		});
		const skills = discoverSkills(cwd, [extraDir]);
		const dup = skills.find((s) => s.id === "dup");
		expect(dup).toBeDefined();
		expect(dup!.description).toBe("Project version.");
	});

	it("expands ~/ prefix in extraPaths using homedir", () => {
		const cwd = tmp();
		// Write a skill into the mocked fakeHome.
		const extraDir = join(fakeHome, "my-skills");
		writeSkill(extraDir, "tilde-skill", {
			name: "tilde-skill",
			description: "Tilde expanded.",
		});
		const skills = discoverSkills(cwd, ["~/my-skills"]);
		expect(skills.find((s) => s.id === "tilde-skill")).toBeDefined();
	});

	it("resolves relative extraPaths against cwd", () => {
		const cwd = tmp();
		// Create a subdir with a skill, reference it relative to cwd.
		writeSkill(join(cwd, "custom-skills"), "rel-skill", {
			name: "rel-skill",
			description: "Relative path.",
		});
		const skills = discoverSkills(cwd, ["./custom-skills"]);
		expect(skills.find((s) => s.id === "rel-skill")).toBeDefined();
	});

	it("silently skips non-existent extraPaths", () => {
		const cwd = tmp();
		const skills = discoverSkills(cwd, ["/nonexistent/path/12345"]);
		expect(skills).toHaveLength(0);
	});

	it("discovers a skill through a symlinked skill directory", () => {
		const cwd = tmp();
		const real = tmp();
		const target = writeSkill(real, "linked-real", {
			name: "linked",
			description: "Reached through a symlink.",
		});
		const skillsRoot = join(cwd, ".opencode", "skills");
		mkdirSync(skillsRoot, { recursive: true });
		symlinkSync(target, join(skillsRoot, "linked"));
		const skills = discoverSkills(cwd);
		const linked = skills.find((s) => s.id === "linked");
		expect(linked).toBeDefined();
		expect(linked!.description).toBe("Reached through a symlink.");
	});

	it("skips a broken symlink and a symlink pointing at a file", () => {
		const cwd = tmp();
		const skillsRoot = join(cwd, ".opencode", "skills");
		mkdirSync(skillsRoot, { recursive: true });
		symlinkSync(join(cwd, "does-not-exist"), join(skillsRoot, "broken"));
		const loose = join(cwd, "loose.md");
		writeFileSync(loose, "not a skill dir", "utf8");
		symlinkSync(loose, join(skillsRoot, "file-link"));
		expect(discoverSkills(cwd)).toHaveLength(0);
	});

	it("collects supporting files reached through symlinks", () => {
		const cwd = tmp();
		const real = tmp();
		const refTarget = join(real, "reference.md");
		writeFileSync(refTarget, "reference body", "utf8");
		const assetsTarget = join(real, "assets");
		mkdirSync(assetsTarget, { recursive: true });
		writeFileSync(join(assetsTarget, "note.txt"), "note", "utf8");

		const dir = writeSkill(join(cwd, ".opencode", "skills"), "with-links", {
			name: "with-links",
			description: "Has symlinked supporting files.",
		});
		symlinkSync(refTarget, join(dir, "reference.md"));
		symlinkSync(assetsTarget, join(dir, "assets"));

		const skill = discoverSkills(cwd).find((s) => s.id === "with-links");
		expect(skill).toBeDefined();
		expect(skill!.files).toContain("reference.md");
		expect(skill!.files).toContain(join("assets", "note.txt"));
	});

	it("does not loop forever on a self-referential symlinked subdirectory", () => {
		const cwd = tmp();
		const dir = writeSkill(join(cwd, ".opencode", "skills"), "cyclic", {
			name: "cyclic",
			description: "Contains a symlink loop.",
		});
		writeFileSync(join(dir, "real.txt"), "real", "utf8");
		symlinkSync(dir, join(dir, "loop"));
		const skill = discoverSkills(cwd).find((s) => s.id === "cyclic");
		expect(skill).toBeDefined();
		expect(skill!.files).toContain("real.txt");
	});
});

describe("filterSkills", () => {
	function makeSkill(id: string): DiscoveredSkill {
		return {
			id,
			name: id,
			description: `Skill ${id}`,
			sourceDir: `/fake/${id}`,
			files: [],
		};
	}

	it("allows all skills when no permission config is present", () => {
		const result = filterSkills([makeSkill("a"), makeSkill("b")], undefined);
		expect(result.skills).toHaveLength(2);
		expect(result.withheld).toHaveLength(0);
	});

	it("denies a skill via map-form permission", () => {
		const config = {
			permission: { skill: { a: "deny" as const } },
		} as unknown as Config;
		const result = filterSkills([makeSkill("a"), makeSkill("b")], config);
		expect(result.skills.map((s) => s.id)).toEqual(["b"]);
		expect(result.withheld).toHaveLength(1);
		expect(result.withheld[0]!.reason).toContain("denied");
	});

	it("withholds ask-permissioned skills", () => {
		const config = {
			permission: { skill: { a: "ask" as const } },
		} as unknown as Config;
		const result = filterSkills([makeSkill("a"), makeSkill("b")], config);
		expect(result.skills.map((s) => s.id)).toEqual(["b"]);
		expect(result.withheld).toHaveLength(1);
		expect(result.withheld[0]!.reason).toContain("ask");
	});

	it("supports wildcard patterns in map-form permission", () => {
		const config = {
			permission: {
				skill: {
					"*": "allow" as const,
					"internal-*": "deny" as const,
				},
			},
		} as unknown as Config;
		const result = filterSkills(
			[makeSkill("public"), makeSkill("internal-secret")],
			config,
		);
		expect(result.skills.map((s) => s.id)).toEqual(["public"]);
		expect(result.withheld.map((w) => w.id)).toEqual(["internal-secret"]);
	});

	it("last-matching pattern wins in map-form", () => {
		const config = {
			permission: {
				skill: {
					"*": "deny" as const,
					special: "allow" as const,
				},
			},
		} as unknown as Config;
		const result = filterSkills(
			[makeSkill("special"), makeSkill("other")],
			config,
		);
		expect(result.skills.map((s) => s.id)).toEqual(["special"]);
		expect(result.withheld.map((w) => w.id)).toEqual(["other"]);
	});

	it("supports rule-array form (last-matching-rule wins)", () => {
		const config = {
			permission: [
				{ permission: "skill", pattern: "*", action: "allow" },
				{ permission: "skill", pattern: "blocked", action: "deny" },
			],
		} as unknown as Config;
		const result = filterSkills([makeSkill("ok"), makeSkill("blocked")], config);
		expect(result.skills.map((s) => s.id)).toEqual(["ok"]);
		expect(result.withheld.map((w) => w.id)).toEqual(["blocked"]);
	});

	it("manual exclude always drops a skill", () => {
		const result = filterSkills([makeSkill("a"), makeSkill("b")], undefined, {
			exclude: ["a"],
		});
		expect(result.skills.map((s) => s.id)).toEqual(["b"]);
		expect(result.withheld[0]!.reason).toContain("excluded");
	});

	it("supports wildcard patterns in manual include and exclude lists", () => {
		const result = filterSkills(
			[
				makeSkill("public-one"),
				makeSkill("public-two"),
				makeSkill("internal-one"),
			],
			undefined,
			{ include: ["*-one"], exclude: ["internal-*"] },
		);
		expect(result.skills.map((s) => s.id)).toEqual(["public-one"]);
	});

	it("manual include keeps a skill even if permission denies it", () => {
		const config = {
			permission: { skill: { a: "deny" as const } },
		} as unknown as Config;
		const result = filterSkills([makeSkill("a"), makeSkill("b")], config, {
			include: ["a"],
		});
		expect(result.skills.map((s) => s.id)).toEqual(["a"]);
	});

	it("manual include list filters out non-listed skills", () => {
		const result = filterSkills(
			[makeSkill("a"), makeSkill("b"), makeSkill("c")],
			undefined,
			{ include: ["a", "c"] },
		);
		expect(result.skills.map((s) => s.id)).toEqual(["a", "c"]);
		expect(result.withheld.find((w) => w.id === "b")).toBeDefined();
	});
});

describe("plugin-bundled skills", () => {
	/** Lay down a fake cache entry: `<root>/<entry>/node_modules/<pkg>/skills/<id>`. */
	function writeCacheSkill(
		cacheRoot: string,
		entry: string,
		pkg: string,
		id: string,
		fm: { name: string; description: string },
		extra?: Record<string, string>,
	): string {
		return writeSkill(
			join(cacheRoot, entry, "node_modules", pkg, "skills"),
			id,
			fm,
			"Plugin skill content.",
			extra,
		);
	}

	it("discovers a skill bundled in an unscoped plugin cache entry", () => {
		const cwd = tmp();
		const cacheRoot = tmp();
		writeCacheSkill(
			cacheRoot,
			"context-mode@latest",
			"context-mode",
			"ctx-search",
			{
				name: "ctx-search",
				description: "Search the knowledge base.",
			},
		);
		const skills = discoverSkills(cwd, undefined, { cacheRoot });
		expect(skills.find((s) => s.id === "ctx-search")).toBeDefined();
	});

	it("discovers a skill in a scoped cache entry (@scope/name@latest)", () => {
		const cwd = tmp();
		const cacheRoot = tmp();
		writeCacheSkill(
			cacheRoot,
			join("@stablekernel", "opencode-bifrost@latest"),
			join("@stablekernel", "opencode-bifrost"),
			"bifrost-skill",
			{ name: "bifrost-skill", description: "Bundled scoped." },
		);
		const skills = discoverSkills(cwd, undefined, { cacheRoot });
		expect(skills.find((s) => s.id === "bifrost-skill")).toBeDefined();
	});

	it("discovers a skill in a git-spec cache entry (nested spec path)", () => {
		const cwd = tmp();
		const cacheRoot = tmp();
		writeCacheSkill(
			cacheRoot,
			join("superpowers@git+https:", "github.com", "obra", "superpowers.git"),
			"superpowers",
			"brainstorming",
			{ name: "brainstorming", description: "Git-spec bundled." },
		);
		const skills = discoverSkills(cwd, undefined, { cacheRoot });
		expect(skills.find((s) => s.id === "brainstorming")).toBeDefined();
	});

	it("ignores cache entries without skills (language servers, formatters)", () => {
		const cwd = tmp();
		const cacheRoot = tmp();
		// A tooling entry with no skills/ dir under node_modules.
		mkdirSync(
			join(
				cacheRoot,
				"typescript-language-server@latest",
				"node_modules",
				"typescript-language-server",
			),
			{ recursive: true },
		);
		const skills = discoverSkills(cwd, undefined, { cacheRoot });
		expect(skills).toHaveLength(0);
	});

	it("ignores the cache root's own node_modules and lockfiles", () => {
		const cwd = tmp();
		const cacheRoot = tmp();
		mkdirSync(join(cacheRoot, "node_modules", "some-dep"), { recursive: true });
		writeFileSync(join(cacheRoot, "package-lock.json"), "{}", "utf8");
		// A skill inside the root-level node_modules must NOT be treated as a
		// plugin-bundled skill (that dir holds transitive deps, not plugins).
		writeSkill(
			join(cacheRoot, "node_modules", "some-dep", "skills"),
			"dep-skill",
			{
				name: "dep-skill",
				description: "Transitive dep, not a plugin.",
			},
		);
		const skills = discoverSkills(cwd, undefined, { cacheRoot });
		expect(skills.find((s) => s.id === "dep-skill")).toBeUndefined();
	});

	it("collects supporting files from a plugin-bundled skill", () => {
		const cwd = tmp();
		const cacheRoot = tmp();
		writeCacheSkill(
			cacheRoot,
			"ctx@latest",
			"ctx",
			"ctx-index",
			{ name: "ctx-index", description: "Index content." },
			{ "reference.md": "ref content" },
		);
		const skills = discoverSkills(cwd, undefined, { cacheRoot });
		const skill = skills.find((s) => s.id === "ctx-index");
		expect(skill).toBeDefined();
		expect(skill!.files).toContain("reference.md");
	});

	it("project skills beat plugin-bundled skills on duplicate id", () => {
		const cwd = tmp();
		const cacheRoot = tmp();
		writeSkill(join(cwd, ".opencode", "skills"), "dup", {
			name: "dup",
			description: "Project version.",
		});
		writeCacheSkill(cacheRoot, "ctx@latest", "ctx", "dup", {
			name: "dup",
			description: "Plugin version.",
		});
		const skills = discoverSkills(cwd, undefined, { cacheRoot });
		const dup = skills.find((s) => s.id === "dup");
		expect(dup).toBeDefined();
		expect(dup!.description).toBe("Project version.");
	});

	it("plugin-bundled skills are lower priority than extraPaths", () => {
		const cwd = tmp();
		const cacheRoot = tmp();
		const extraDir = tmp();
		writeSkill(extraDir, "dup", {
			name: "dup",
			description: "Extra path version.",
		});
		writeCacheSkill(cacheRoot, "ctx@latest", "ctx", "dup", {
			name: "dup",
			description: "Plugin version.",
		});
		const skills = discoverSkills(cwd, [extraDir], { cacheRoot });
		const dup = skills.find((s) => s.id === "dup");
		expect(dup!.description).toBe("Extra path version.");
	});

	it("discovers sibling skills of file-based plugins (global plugins dir)", () => {
		const cwd = tmp();
		// Global config root with a file plugin and its sibling skills dir.
		const globalRoot = join(fakeHome, ".config", "opencode");
		mkdirSync(join(globalRoot, "plugins"), { recursive: true });
		writeFileSync(
			join(globalRoot, "plugins", "my-plugin.ts"),
			"// plugin\n",
			"utf8",
		);
		writeSkill(join(globalRoot, "plugins", "skills"), "file-plugin-skill", {
			name: "file-plugin-skill",
			description: "Bundled alongside a file plugin.",
		});
		const cacheRoot = tmp(); // empty cache so the default scan is quiet
		const skills = discoverSkills(cwd, undefined, { cacheRoot });
		expect(skills.find((s) => s.id === "file-plugin-skill")).toBeDefined();
	});

	it("discovers sibling skills of project file plugins (.opencode/plugin)", () => {
		const cwd = tmp();
		const cacheRoot = tmp();
		mkdirSync(join(cwd, ".opencode", "plugin"), { recursive: true });
		writeFileSync(
			join(cwd, ".opencode", "plugin", "local.ts"),
			"// plugin\n",
			"utf8",
		);
		writeSkill(join(cwd, ".opencode", "plugin", "skills"), "local-plugin-skill", {
			name: "local-plugin-skill",
			description: "Project file plugin skill.",
		});
		const skills = discoverSkills(cwd, undefined, { cacheRoot });
		expect(skills.find((s) => s.id === "local-plugin-skill")).toBeDefined();
	});

	it("project file-plugin skills beat global file-plugin skills on duplicate id", () => {
		const cwd = tmp();
		const cacheRoot = tmp();
		const globalRoot = join(fakeHome, ".config", "opencode");
		mkdirSync(join(globalRoot, "plugins"), { recursive: true });
		writeSkill(join(globalRoot, "plugins", "skills"), "dup-file", {
			name: "dup-file",
			description: "Global file-plugin version.",
		});
		mkdirSync(join(cwd, ".opencode", "plugin"), { recursive: true });
		writeSkill(join(cwd, ".opencode", "plugin", "skills"), "dup-file", {
			name: "dup-file",
			description: "Project file-plugin version.",
		});
		const skills = discoverSkills(cwd, undefined, { cacheRoot });
		const dup = skills.find((s) => s.id === "dup-file");
		expect(dup!.description).toBe("Project file-plugin version.");
	});

	it("applies permission deny to plugin-bundled skills", () => {
		const cwd = tmp();
		const cacheRoot = tmp();
		writeCacheSkill(cacheRoot, "ctx@latest", "ctx", "ctx-search", {
			name: "ctx-search",
			description: "Denied plugin skill.",
		});
		const config = {
			permission: { skill: { "ctx-*": "deny" } },
		} as unknown as Config;
		const result = resolveSkills(cwd, config, undefined, { cacheRoot });
		expect(result.skills.find((s) => s.id === "ctx-search")).toBeUndefined();
		expect(result.withheld.find((w) => w.id === "ctx-search")).toBeDefined();
	});

	it("manual include selects only listed plugin-bundled skills", () => {
		const cwd = tmp();
		const cacheRoot = tmp();
		writeCacheSkill(cacheRoot, "ctx@latest", "ctx", "ctx-search", {
			name: "ctx-search",
			description: "Included.",
		});
		writeCacheSkill(cacheRoot, "ctx@latest", "ctx", "ctx-index", {
			name: "ctx-index",
			description: "Not included.",
		});
		const result = resolveSkills(
			cwd,
			undefined,
			{ include: ["ctx-search"] },
			{ cacheRoot },
		);
		expect(result.skills.map((s) => s.id)).toEqual(["ctx-search"]);
	});

	it("skips a nonexistent cache root silently", () => {
		const cwd = tmp();
		const skills = discoverSkills(cwd, undefined, {
			cacheRoot: join(tmp(), "does-not-exist"),
		});
		expect(skills).toHaveLength(0);
	});
});

describe("resolvePluginSkillSources", () => {
	it("returns the cache root and real file-plugin roots", async () => {
		const { resolvePluginSkillSources } = await import(
			"../src/plugin/skill-discovery.js"
		);
		const cacheRoot = join(fakeHome, ".cache", "opencode", "packages");
		const globalRoot = join(fakeHome, ".config", "opencode");
		mkdirSync(join(globalRoot, "plugins"), { recursive: true });
		writeFileSync(join(globalRoot, "plugins", "x.ts"), "// plugin\n", "utf8");
		mkdirSync(join(globalRoot, "plugins", "skills", "a"), { recursive: true });
		writeFileSync(
			join(globalRoot, "plugins", "skills", "a", "SKILL.md"),
			"---\nname: a\ndescription: d\n---\nbody",
			"utf8",
		);
		const cwd = tmp();
		const result = resolvePluginSkillSources(cwd);
		expect(result.cacheRoot).toBe(cacheRoot);
		expect(result.filePluginRoots).toContain(globalRoot);
	});
});

describe("resolveSkills", () => {
	it("combines discovery and filtering, never throws", () => {
		const cwd = tmp();
		writeSkill(join(cwd, ".opencode", "skills"), "test", {
			name: "test",
			description: "Test skill.",
		});
		const result = resolveSkills(cwd);
		expect(result.skills).toHaveLength(1);
		expect(result.skills[0]!.id).toBe("test");
	});

	it("changes the skill-set hash when a supporting file changes", () => {
		const cwd = tmp();
		const skillDir = writeSkill(join(cwd, ".opencode", "skills"), "test", {
			name: "test",
			description: "Test skill.",
		});
		writeFileSync(join(skillDir, "reference.md"), "one", "utf8");
		const first = resolveSkills(cwd).skills;
		const firstHash = skillSetHash(first);

		writeFileSync(join(skillDir, "reference.md"), "longer content", "utf8");
		const secondHash = skillSetHash(resolveSkills(cwd).skills);
		expect(secondHash).not.toBe(firstHash);
	});
});

describe("live skills merge (app.skills)", () => {
	it("merges live skills the filesystem scan missed, at lowest priority", () => {
		const cwd = tmp();
		const cacheRoot = tmp();
		// A project skill the scan finds.
		writeSkill(join(cwd, ".opencode", "skills"), "seen-skill", {
			name: "seen-skill",
			description: "Found by scan.",
		});
		// A live-only skill located in a dir the scan doesn't cover.
		const liveDir = tmp();
		writeSkill(liveDir, "live-only", {
			name: "live-only",
			description: "Only opencode knows about this one.",
		});
		// A duplicate: live reports the same id as the project skill.
		const dupDir = tmp();
		writeSkill(dupDir, "seen-skill", {
			name: "seen-skill",
			description: "Live duplicate — must lose.",
		});
		const result = resolveSkills(cwd, undefined, undefined, {
			cacheRoot,
			liveSkills: [
				{
					name: "live-only",
					description: "Only opencode knows about this one.",
					location: join(liveDir, "live-only", "SKILL.md"),
				},
				{
					name: "seen-skill",
					description: "Live duplicate — must lose.",
					location: join(dupDir, "seen-skill", "SKILL.md"),
				},
			],
		});
		const ids = result.skills.map((s) => s.id).sort();
		expect(ids).toEqual(["live-only", "seen-skill"]);
		const dup = result.skills.find((s) => s.id === "seen-skill");
		expect(dup!.description).toBe("Found by scan.");
	});

	it("skips live entries whose location is missing on disk", () => {
		const cwd = tmp();
		const result = resolveSkills(cwd, undefined, undefined, {
			cacheRoot: tmp(),
			liveSkills: [
				{
					name: "ghost",
					description: "Gone.",
					location: "/nonexistent/ghost/SKILL.md",
				},
			],
		});
		expect(result.skills).toHaveLength(0);
	});

	it("applies permission filtering to live-sourced skills", () => {
		const cwd = tmp();
		const liveDir = tmp();
		writeSkill(liveDir, "live-denied", {
			name: "live-denied",
			description: "Denied.",
		});
		const config = {
			permission: { skill: { "live-*": "deny" } },
		} as unknown as Config;
		const result = resolveSkills(cwd, config, undefined, {
			cacheRoot: tmp(),
			liveSkills: [
				{
					name: "live-denied",
					description: "Denied.",
					location: join(liveDir, "live-denied", "SKILL.md"),
				},
			],
		});
		expect(result.skills).toHaveLength(0);
		expect(result.withheld.find((w) => w.id === "live-denied")).toBeDefined();
	});
});

describe("live built-in (content-only) skills", () => {
	it("materialises a <built-in> skill so the mirror can copy it", () => {
		const cwd = tmp();
		const cacheRoot = tmp();
		const result = resolveSkills(cwd, undefined, undefined, {
			cacheRoot,
			liveSkills: [
				{
					name: "customize-opencode",
					description: "Use ONLY when editing opencode config.",
					location: "<built-in>",
					content: "# Customizing opencode\n\nBody here.",
				},
			],
		});
		const skill = result.skills.find((s) => s.id === "customize-opencode");
		expect(skill).toBeDefined();
		expect(skill!.description).toBe("Use ONLY when editing opencode config.");
		// The materialised dir holds a real SKILL.md with frontmatter + body.
		const md = readFileSync(join(skill!.sourceDir, "SKILL.md"), "utf8");
		expect(md).toContain("name: customize-opencode");
		expect(md).toContain("# Customizing opencode");
		// Second resolve with identical input must not rewrite the file
		// (mtimes stable → skillSetHash stable → no per-turn mirror churn).
		const mtimeBefore = statSync(join(skill!.sourceDir, "SKILL.md")).mtimeMs;
		resolveSkills(cwd, undefined, undefined, {
			cacheRoot,
			liveSkills: [
				{
					name: "customize-opencode",
					description: "Use ONLY when editing opencode config.",
					location: "<built-in>",
					content: "# Customizing opencode\n\nBody here.",
				},
			],
		});
		const mtimeAfter = statSync(join(skill!.sourceDir, "SKILL.md")).mtimeMs;
		expect(mtimeAfter).toBe(mtimeBefore);
	});

	it("rewrites the materialised copy when opencode's content changes", () => {
		const cwd = tmp();
		const cacheRoot = tmp();
		const mk = (content: string) =>
			resolveSkills(cwd, undefined, undefined, {
				cacheRoot,
				liveSkills: [
					{
						name: "builtin-v2",
						description: "Built-in.",
						location: "<built-in>",
						content,
					},
				],
			});
		const first = mk("# v1");
		expect(first.skills.find((s) => s.id === "builtin-v2")).toBeDefined();
		const dir = first.skills.find((s) => s.id === "builtin-v2")!.sourceDir;
		const second = mk("# v2 updated");
		const md = readFileSync(join(dir, "SKILL.md"), "utf8");
		expect(md).toContain("# v2 updated");
		expect(second.skills).toHaveLength(1);
	});

	it("skips content-only entries without content or description", () => {
		const cwd = tmp();
		const result = resolveSkills(cwd, undefined, undefined, {
			cacheRoot: tmp(),
			liveSkills: [
				{ name: "no-content", description: "d", location: "<built-in>" },
				{
					name: "no-description",
					location: "<built-in>",
					content: "# body",
				},
			],
		});
		expect(result.skills).toHaveLength(0);
	});
});
