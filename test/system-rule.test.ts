import { afterEach, describe, expect, it } from "vitest";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	existsSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV3Prompt } from "@ai-sdk/provider";
import {
	extractSystemText,
	writeSystemRule,
	removeSystemRule,
} from "../src/provider/system-rule.js";

const dirs: string[] = [];
function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), "cursor-rule-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("extractSystemText", () => {
	it("concatenates all system messages, trimmed", () => {
		const prompt: LanguageModelV3Prompt = [
			{ role: "system", content: "You are opencode." },
			{ role: "user", content: [{ type: "text", text: "hi" }] },
			{ role: "system", content: "Be terse." },
		];
		expect(extractSystemText(prompt)).toBe("You are opencode.\n\nBe terse.");
	});
	it("returns empty string when there is no system message", () => {
		const prompt: LanguageModelV3Prompt = [
			{ role: "user", content: [{ type: "text", text: "hi" }] },
		];
		expect(extractSystemText(prompt)).toBe("");
	});
});

describe("writeSystemRule", () => {
	it("writes an always-applied .mdc rule and git-ignores it", () => {
		const cwd = tmp();
		const wrote = writeSystemRule(cwd, "Follow project conventions.");
		expect(wrote).toBe(true);
		const rulePath = join(cwd, ".cursor", "rules", "opencode.mdc");
		const body = readFileSync(rulePath, "utf8");
		expect(body).toBe(
			"---\nalwaysApply: true\n---\n\nFollow project conventions.\n",
		);
		const ignore = readFileSync(
			join(cwd, ".cursor", "rules", ".gitignore"),
			"utf8",
		);
		expect(ignore.split(/\r?\n/)).toContain("opencode.mdc");
	});
	it("is a no-op for empty text", () => {
		const cwd = tmp();
		expect(writeSystemRule(cwd, "")).toBe(false);
		expect(existsSync(join(cwd, ".cursor", "rules", "opencode.mdc"))).toBe(
			false,
		);
	});
	it("does not duplicate the .gitignore entry on rewrite", () => {
		const cwd = tmp();
		writeSystemRule(cwd, "a");
		writeSystemRule(cwd, "b");
		const ignore = readFileSync(
			join(cwd, ".cursor", "rules", ".gitignore"),
			"utf8",
		);
		expect(ignore.match(/opencode\.mdc/g)).toHaveLength(1);
	});
	it("overwrites the rule body on rewrite", () => {
		const cwd = tmp();
		writeSystemRule(cwd, "first");
		writeSystemRule(cwd, "second");
		const body = readFileSync(
			join(cwd, ".cursor", "rules", "opencode.mdc"),
			"utf8",
		);
		expect(body).toBe("---\nalwaysApply: true\n---\n\nsecond\n");
		expect(body).not.toContain("first");
	});
	it("preserves a pre-existing .gitignore and appends the rule", () => {
		const cwd = tmp();
		const dir = join(cwd, ".cursor", "rules");
		mkdirSync(dir, { recursive: true });
		// Pre-existing entry with no trailing newline exercises the prefix path.
		writeFileSync(join(dir, ".gitignore"), "other.txt", "utf8");
		writeSystemRule(cwd, "x");
		const ignore = readFileSync(join(dir, ".gitignore"), "utf8");
		const lines = ignore.split(/\r?\n/);
		expect(lines).toContain("other.txt");
		expect(lines).toContain("opencode.mdc");
	});
	it("does not re-append when the rule is already git-ignored", () => {
		const cwd = tmp();
		const dir = join(cwd, ".cursor", "rules");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, ".gitignore"), "opencode.mdc\n", "utf8");
		writeSystemRule(cwd, "x");
		const ignore = readFileSync(join(dir, ".gitignore"), "utf8");
		expect(ignore.match(/opencode\.mdc/g)).toHaveLength(1);
	});
});

describe("removeSystemRule", () => {
	it("deletes the generated rule and tolerates a missing file", () => {
		const cwd = tmp();
		writeSystemRule(cwd, "x");
		removeSystemRule(cwd);
		expect(existsSync(join(cwd, ".cursor", "rules", "opencode.mdc"))).toBe(
			false,
		);
		expect(() => removeSystemRule(cwd)).not.toThrow();
	});
});
