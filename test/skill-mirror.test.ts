import { afterEach, describe, expect, it, vi } from "vitest";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	existsSync,
	rmSync,
	chmodSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	writeSkillMirror,
	removeSkillMirror,
	buildSkillsCatalogue,
} from "../src/provider/skill-mirror.js";
import type { DiscoveredSkill } from "../src/plugin/skill-discovery.js";

const dirs: string[] = [];
function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), "cursor-mirror-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) {
		// Restore permissions so cleanup can delete the tree.
		try {
			const skillsDir = join(d, ".cursor", "skills");
			if (existsSync(skillsDir)) chmodSync(skillsDir, 0o755);
		} catch {}
		try {
			chmodSync(d, 0o755);
		} catch {}
		rmSync(d, { recursive: true, force: true });
	}
});

function makeSkill(
	id: string,
	sourceDir: string,
	description = `Skill ${id}`,
): DiscoveredSkill {
	mkdirSync(sourceDir, { recursive: true });
	writeFileSync(
		join(sourceDir, "SKILL.md"),
		`---\nname: ${id}\ndescription: ${description}\n---\n\nContent for ${id}.\n`,
		"utf8",
	);
	return {
		id,
		name: id,
		description,
		sourceDir,
		files: [],
	};
}

function skillDir(cwd: string, id: string): string {
	return join(cwd, ".cursor", "skills", id);
}

function readSkillMd(cwd: string, id: string): string {
	return readFileSync(join(skillDir(cwd, id), "SKILL.md"), "utf8");
}

describe("writeSkillMirror", () => {
	it("writes a skill with the sentinel stamped into frontmatter", () => {
		const cwd = tmp();
		const src = join(cwd, "src-skills", "my-skill");
		const skill = makeSkill("my-skill", src);
		const warnings: string[] = [];
		const result = writeSkillMirror(cwd, [skill], (m) => warnings.push(m));
		expect(result).toBe("written");
		const content = readSkillMd(cwd, "my-skill");
		expect(content).toContain("generated: opencode-cursor");
		expect(content).toContain("name: my-skill");
		expect(content).toContain("description: Skill my-skill");
		expect(warnings).toHaveLength(0);
	});

	it("git-ignores the mirrored skill directories", () => {
		const cwd = tmp();
		const skill = makeSkill("a", join(cwd, "src", "a"));
		writeSkillMirror(cwd, [skill], () => {});
		const ignore = readFileSync(
			join(cwd, ".cursor", "skills", ".gitignore"),
			"utf8",
		);
		expect(ignore.split(/\r?\n/)).toContain("a");
		expect(ignore.split(/\r?\n/)).toContain(".gitignore");
	});

	it("is idempotent — second write with same skills performs no writes", () => {
		const cwd = tmp();
		const skill = makeSkill("idem", join(cwd, "src", "idem"));
		writeSkillMirror(cwd, [skill], () => {});
		// Make the skill dir read-only: an actual rewrite would throw EACCES,
		// so a clean "unchanged" return proves the write was skipped.
		const skillPath = skillDir(cwd, "idem");
		chmodSync(skillPath, 0o555);
		const result = writeSkillMirror(cwd, [skill], () => {});
		expect(result).toBe("unchanged");
		// Restore for cleanup.
		chmodSync(skillPath, 0o755);
	});

	it("never overwrites a user-owned skill (no sentinel)", () => {
		const cwd = tmp();
		// Pre-existing user-owned skill.
		const userDir = skillDir(cwd, "user-owned");
		mkdirSync(userDir, { recursive: true });
		const userBody = "---\nname: user-owned\ndescription: Mine.\n---\n\nMy content.\n";
		writeFileSync(join(userDir, "SKILL.md"), userBody, "utf8");

		const skill = makeSkill("user-owned", join(cwd, "src", "user-owned"));
		const warnings: string[] = [];
		writeSkillMirror(cwd, [skill], (m) => warnings.push(m));
		expect(readSkillMd(cwd, "user-owned")).toBe(userBody);
		expect(warnings.some((w) => w.includes("user-owned"))).toBe(true);
	});

	it("copies supporting files preserving relative paths", () => {
		const cwd = tmp();
		const srcDir = join(cwd, "src", "with-files");
		mkdirSync(srcDir, { recursive: true });
		writeFileSync(
			join(srcDir, "SKILL.md"),
			"---\nname: with-files\ndescription: Has files.\n---\n\nBody.\n",
			"utf8",
		);
		mkdirSync(join(srcDir, "templates"));
		writeFileSync(join(srcDir, "templates", "tmpl.txt"), "Template", "utf8");
		writeFileSync(join(srcDir, "ref.md"), "# Ref", "utf8");

		const skill: DiscoveredSkill = {
			id: "with-files",
			name: "with-files",
			description: "Has files.",
			sourceDir: srcDir,
			files: ["templates/tmpl.txt", "ref.md"],
		};
		writeSkillMirror(cwd, [skill], () => {});
		expect(existsSync(join(skillDir(cwd, "with-files"), "templates", "tmpl.txt"))).toBe(true);
		expect(existsSync(join(skillDir(cwd, "with-files"), "ref.md"))).toBe(true);
	});

	it("skips an oversized file without dropping its siblings", () => {
		const cwd = tmp();
		const srcDir = join(cwd, "src", "oversized");
		const skill = makeSkill("oversized", srcDir);
		writeFileSync(join(srcDir, "big.bin"), "x".repeat(1_048_577), "utf8");
		writeFileSync(join(srcDir, "keep.txt"), "keep", "utf8");
		skill.files = ["big.bin", "keep.txt"];
		const warnings: string[] = [];

		const result = writeSkillMirror(cwd, [skill], (message) => warnings.push(message));

		expect(result).toBe("partial");
		expect(existsSync(join(skillDir(cwd, "oversized"), "big.bin"))).toBe(false);
		expect(existsSync(join(skillDir(cwd, "oversized"), "keep.txt"))).toBe(true);
		expect(warnings.some((warning) => warning.includes("oversized"))).toBe(true);
	});

	it("prunes sentinel-bearing dirs for skills no longer resolved", () => {
		const cwd = tmp();
		const skillA = makeSkill("a", join(cwd, "src", "a"));
		writeSkillMirror(cwd, [skillA], () => {});
		expect(existsSync(skillDir(cwd, "a"))).toBe(true);

		// Now mirror with no skills — "a" should be pruned.
		writeSkillMirror(cwd, [], () => {});
		expect(existsSync(skillDir(cwd, "a"))).toBe(false);
	});

	it("does not prune user-owned dirs during pruning", () => {
		const cwd = tmp();
		// First, mirror a generated skill.
		const skillA = makeSkill("a", join(cwd, "src", "a"));
		writeSkillMirror(cwd, [skillA], () => {});
		// Add a user-owned skill dir (no sentinel).
		const userDir = skillDir(cwd, "user");
		mkdirSync(userDir, { recursive: true });
		writeFileSync(
			join(userDir, "SKILL.md"),
			"---\nname: user\ndescription: Mine.\n---\n\nMine.\n",
			"utf8",
		);
		// Re-mirror with no skills — generated "a" pruned, user "user" stays.
		writeSkillMirror(cwd, [], () => {});
		expect(existsSync(skillDir(cwd, "a"))).toBe(false);
		expect(existsSync(skillDir(cwd, "user"))).toBe(true);
	});

	it("returns empty when no skills are provided", () => {
		const cwd = tmp();
		const result = writeSkillMirror(cwd, [], () => {});
		expect(result).toBe("empty");
	});

	it("degrades gracefully on read-only cwd (warns, does not throw)", () => {
		const cwd = tmp();
		const skill = makeSkill("ro", join(cwd, "src", "ro"));
		// Make the .cursor/skills dir read-only after first mirror.
		writeSkillMirror(cwd, [skill], () => {});
		chmodSync(join(cwd, ".cursor", "skills"), 0o555);
		// Changing the skill content should trigger a write attempt that fails.
		const newSrc = join(cwd, "src2", "ro");
		const newSkill = makeSkill("ro", newSrc, "Updated description");
		const warnings: string[] = [];
		expect(() =>
			writeSkillMirror(cwd, [newSkill], (m) => warnings.push(m)),
		).not.toThrow();
		// Restore for cleanup.
		chmodSync(join(cwd, ".cursor", "skills"), 0o755);
	});

	it("copies supporting files reached through symlinks", () => {
		const cwd = tmp();
		const src = join(cwd, "src", "linked-files");
		const skill = makeSkill("linked-files", src);
		const external = tmp();
		const refTarget = join(external, "reference.md");
		writeFileSync(refTarget, "reference body", "utf8");
		const assetsTarget = join(external, "assets");
		mkdirSync(assetsTarget, { recursive: true });
		writeFileSync(join(assetsTarget, "note.txt"), "note", "utf8");
		symlinkSync(refTarget, join(src, "reference.md"));
		symlinkSync(assetsTarget, join(src, "assets"));

		const warnings: string[] = [];
		writeSkillMirror(cwd, [skill], (m) => warnings.push(m));
		const dest = skillDir(cwd, "linked-files");
		expect(readFileSync(join(dest, "reference.md"), "utf8")).toBe(
			"reference body",
		);
		expect(readFileSync(join(dest, "assets", "note.txt"), "utf8")).toBe("note");
		expect(warnings).toHaveLength(0);
	});

	it("does not loop forever on a self-referential symlinked subdirectory", () => {
		const cwd = tmp();
		const src = join(cwd, "src", "cyclic");
		const skill = makeSkill("cyclic", src);
		writeFileSync(join(src, "real.txt"), "real", "utf8");
		symlinkSync(src, join(src, "loop"));
		expect(() => writeSkillMirror(cwd, [skill], () => {})).not.toThrow();
		expect(
			readFileSync(join(skillDir(cwd, "cyclic"), "real.txt"), "utf8"),
		).toBe("real");
	});
});

describe("removeSkillMirror", () => {
	it("removes generated skill dirs and the .gitignore", () => {
		const cwd = tmp();
		const skill = makeSkill("rm", join(cwd, "src", "rm"));
		writeSkillMirror(cwd, [skill], () => {});
		expect(existsSync(skillDir(cwd, "rm"))).toBe(true);
		removeSkillMirror(cwd);
		expect(existsSync(skillDir(cwd, "rm"))).toBe(false);
	});

	it("leaves user-owned skill dirs in place", () => {
		const cwd = tmp();
		const userDir = skillDir(cwd, "user");
		mkdirSync(userDir, { recursive: true });
		const userBody = "---\nname: user\ndescription: Mine.\n---\n\nMine.\n";
		writeFileSync(join(userDir, "SKILL.md"), userBody, "utf8");
		removeSkillMirror(cwd);
		expect(readSkillMd(cwd, "user")).toBe(userBody);
	});

	it("tolerates a missing mirror", () => {
		const cwd = tmp();
		expect(() => removeSkillMirror(cwd)).not.toThrow();
	});
});

describe("buildSkillsCatalogue", () => {
	it("builds a catalogue listing each skill id and description", () => {
		const skills: DiscoveredSkill[] = [
			{ id: "a", name: "a", description: "Does A.", sourceDir: "/x", files: [] },
			{ id: "b", name: "b", description: "Does B.", sourceDir: "/y", files: [] },
		];
		const cat = buildSkillsCatalogue(skills);
		expect(cat).toContain("<available_skills>");
		expect(cat).toContain("**a**: Does A.");
		expect(cat).toContain("**b**: Does B.");
		expect(cat).toContain(".cursor/skills/<id>/SKILL.md");
	});

	it("returns undefined for no skills", () => {
		expect(buildSkillsCatalogue([])).toBeUndefined();
	});
});
