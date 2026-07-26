import { afterEach, describe, expect, it, vi } from "vitest";
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "@opencode-ai/plugin";

// Mock homedir so global skill discovery doesn't pick up real skills.
const fakeHome = mkdtempSync(join(tmpdir(), "cursor-plugin-skill-home-"));
vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	return { ...actual, homedir: () => fakeHome };
});

// Keep the config hook offline: no live model discovery.
vi.mock("../src/model-discovery.js", () => ({
	discoverModels: async () => ({ models: [], source: "fallback" }),
	toOpencodeModels: () => ({}),
}));

const { default: plugin } = await import("../src/plugin/index.js");

const dirs: string[] = [];
function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), "cursor-plugin-skill-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function skillMirrorDir(cwd: string): string {
	return join(cwd, ".cursor", "skills");
}

function writeTestSkill(
	base: string,
	id: string,
	description = `Skill ${id}`,
): void {
	const dir = join(base, id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "SKILL.md"),
		`---\nname: ${id}\ndescription: ${description}\n---\n\nContent.\n`,
		"utf8",
	);
}

describe("CursorPlugin skill mirror", () => {
	it("materialises the skill mirror in the config hook", async () => {
		const dir = tmp();
		// Create a project skill.
		writeTestSkill(join(dir, ".opencode", "skills"), "test-skill");

		const hooks = await plugin({ directory: dir } as never);
		const config = { provider: {}, mcp: {} } as never;
		await hooks.config!(config);

		const mirrorPath = join(skillMirrorDir(dir), "test-skill", "SKILL.md");
		expect(existsSync(mirrorPath)).toBe(true);
		const content = readFileSync(mirrorPath, "utf8");
		expect(content).toContain("generated: opencode-cursor");
		expect(content).toContain("name: test-skill");
	});

	it("threads skillsCatalogue into provider options", async () => {
		const dir = tmp();
		writeTestSkill(join(dir, ".opencode", "skills"), "cat-skill");

		const hooks = await plugin({ directory: dir } as never);
		const config = { provider: {}, mcp: {} } as never;
		await hooks.config!(config);
		const options = (config as { provider: Record<string, { options?: Record<string, unknown> }> })
			.provider["cursor"]!.options!;
		const catalogue = options["skillsCatalogue"];
		expect(typeof catalogue).toBe("string");
		expect(catalogue as string).toContain("<available_skills>");
		expect(catalogue as string).toContain("cat-skill");
	});

	it("removes the mirror on dispose", async () => {
		const dir = tmp();
		writeTestSkill(join(dir, ".opencode", "skills"), "dispose-skill");

		const hooks = await plugin({ directory: dir } as never);
		const config = { provider: {}, mcp: {} } as never;
		await hooks.config!(config);
		expect(
			existsSync(join(skillMirrorDir(dir), "dispose-skill", "SKILL.md")),
		).toBe(true);

		await hooks.dispose!();
		expect(
			existsSync(join(skillMirrorDir(dir), "dispose-skill")),
		).toBe(false);
	});

	it("respects forwardSkills:false opt-out", async () => {
		const dir = tmp();
		writeTestSkill(join(dir, ".opencode", "skills"), "opt-out");

		const hooks = await plugin({ directory: dir } as never);
		const config = {
			provider: { cursor: { options: { forwardSkills: false } } },
			mcp: {},
		} as never;
		await hooks.config!(config);
		expect(
			existsSync(join(skillMirrorDir(dir), "opt-out")),
		).toBe(false);
	});

	it("respects skills.exclude to drop a skill", async () => {
		const dir = tmp();
		writeTestSkill(join(dir, ".opencode", "skills"), "excluded");
		writeTestSkill(join(dir, ".opencode", "skills"), "included");

		const hooks = await plugin({ directory: dir } as never);
		const config = {
			provider: { cursor: { options: { skills: { exclude: ["excluded"] } } } },
			mcp: {},
		} as never;
		await hooks.config!(config);
		expect(
			existsSync(join(skillMirrorDir(dir), "excluded")),
		).toBe(false);
		expect(
			existsSync(join(skillMirrorDir(dir), "included")),
		).toBe(true);
	});

	it("respects skills.include to keep only listed skills", async () => {
		const dir = tmp();
		writeTestSkill(join(dir, ".opencode", "skills"), "keep");
		writeTestSkill(join(dir, ".opencode", "skills"), "drop");

		const hooks = await plugin({ directory: dir } as never);
		const config = {
			provider: { cursor: { options: { skills: { include: ["keep"] } } } },
			mcp: {},
		} as never;
		await hooks.config!(config);
		expect(
			existsSync(join(skillMirrorDir(dir), "keep")),
		).toBe(true);
		expect(
			existsSync(join(skillMirrorDir(dir), "drop")),
		).toBe(false);
	});

	it("does not overwrite a user-owned skill in .cursor/skills/", async () => {
		const dir = tmp();
		// Pre-existing user-owned skill.
		const userDir = join(skillMirrorDir(dir), "user-skill");
		mkdirSync(userDir, { recursive: true });
		const userBody = "---\nname: user-skill\ndescription: Mine.\n---\n\nMy content.\n";
		writeFileSync(join(userDir, "SKILL.md"), userBody, "utf8");

		// Same id in opencode skills.
		writeTestSkill(join(dir, ".opencode", "skills"), "user-skill", "Theirs.");

		const hooks = await plugin({ directory: dir } as never);
		const config = { provider: {}, mcp: {} } as never;
		await hooks.config!(config);
		// User-owned file is untouched.
		expect(readFileSync(join(userDir, "SKILL.md"), "utf8")).toBe(userBody);
	});

	it("uses a user-configured provider cwd for the mirror", async () => {
		const dir = tmp();
		const customCwd = tmp();
		writeTestSkill(join(customCwd, ".opencode", "skills"), "custom-cwd");

		const hooks = await plugin({ directory: dir } as never);
		const config = {
			provider: { cursor: { options: { cwd: customCwd } } },
			mcp: {},
		} as never;
		await hooks.config!(config);
		expect(
			existsSync(join(skillMirrorDir(customCwd), "custom-cwd", "SKILL.md")),
		).toBe(true);
		// Cleanup on dispose should target customCwd.
		await hooks.dispose!();
		expect(
			existsSync(join(skillMirrorDir(customCwd), "custom-cwd")),
		).toBe(false);
	});

	it("forwards the current catalogue on every turn and clears removed skills", async () => {
		const dir = tmp();
		const source = join(dir, ".opencode", "skills");
		writeTestSkill(source, "first");
		const config = { provider: {}, mcp: {} } as Config;
		const client = {
			config: { get: async () => ({ data: config }) },
			mcp: { status: async () => ({ data: {} }) },
		};
		const hooks = await plugin({ directory: dir, client } as never);
		await hooks.config!(config as never);
		const input = {
			model: { providerID: "cursor" },
			sessionID: "session",
			agent: "build",
		} as never;

		const firstOutput = { options: {} } as never;
		await hooks["chat.params"]!(input, firstOutput);
		expect((firstOutput as { options: Record<string, string> }).options.skillsCatalogue)
			.toContain("first");

		writeTestSkill(source, "second");
		const secondOutput = { options: {} } as never;
		await hooks["chat.params"]!(input, secondOutput);
		expect((secondOutput as { options: Record<string, string> }).options.skillsCatalogue)
			.toContain("second");

		const unchangedOutput = { options: {} } as never;
		await hooks["chat.params"]!(input, unchangedOutput);
		expect((unchangedOutput as { options: Record<string, string> }).options.skillsCatalogue)
			.toContain("second");

		rmSync(source, { recursive: true, force: true });
		const emptyOutput = { options: {} } as never;
		await hooks["chat.params"]!(input, emptyOutput);
		expect((emptyOutput as { options: Record<string, string> }).options.skillsCatalogue)
			.toBe("");
		expect(existsSync(join(skillMirrorDir(dir), "first"))).toBe(false);
		expect(existsSync(join(skillMirrorDir(dir), "second"))).toBe(false);
	});
});

describe("CursorPlugin skill mirror — sub-agent inheritance", () => {
	it("mirror is materialised at config time before any Cursor turn", async () => {
		const dir = tmp();
		writeTestSkill(join(dir, ".opencode", "skills"), "sub-agent-skill");

		const hooks = await plugin({ directory: dir } as never);
		const config = { provider: {}, mcp: {} } as never;
		await hooks.config!(config);

		// The mirror exists on disk immediately after config, before any turn.
		expect(
			existsSync(join(skillMirrorDir(dir), "sub-agent-skill", "SKILL.md")),
		).toBe(true);

		// The provider options include settingSources that will enable the
		// project layer (where Cursor discovers .cursor/skills/). The system
		// rule delivery resolves this at call time, but the catalogue is
		// already in the options.
		const options = (config as { provider: Record<string, { options?: Record<string, unknown> }> })
			.provider["cursor"]!.options!;
		expect(options["skillsCatalogue"]).toBeDefined();
	});

	it("settingSources reaches the provider via config (survives model-options drop)", async () => {
		const dir = tmp();
		writeTestSkill(join(dir, ".opencode", "skills"), "settings-test");

		const hooks = await plugin({ directory: dir } as never);
		const config = {
			provider: { cursor: { options: { settingSources: ["project", "user"] } } },
			mcp: {},
		} as never;
		await hooks.config!(config);
		const options = (config as { provider: Record<string, { options?: Record<string, unknown> }> })
			.provider["cursor"]!.options!;
		// settingSources is on the provider config, not per-request options,
		// so it survives the sub-agent model-options drop (same as modelParamDefaults).
		expect(options["settingSources"]).toEqual(["project", "user"]);
	});
});
