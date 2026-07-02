import {
	mkdirSync,
	writeFileSync,
	readFileSync,
	existsSync,
	rmSync,
} from "node:fs";
import { join } from "node:path";
import type { LanguageModelV3Prompt } from "@ai-sdk/provider";

/** Location of the generated rule, relative to the agent's cwd. */
const RULES_DIR = join(".cursor", "rules");
const RULE_FILE = "opencode.mdc";
const IGNORE_FILE = ".gitignore";

/** Concatenate every system-message body from an AI-SDK prompt (trimmed). */
export function extractSystemText(prompt: LanguageModelV3Prompt): string {
	const parts: string[] = [];
	for (const message of prompt) {
		if (message.role === "system") parts.push(message.content);
	}
	return parts.join("\n\n").trim();
}

/**
 * Write opencode's system prompt to `<cwd>/.cursor/rules/opencode.mdc` as an
 * always-applied Cursor project rule. Cursor loads this through its authoritative
 * rules channel (`settingSources` including "project"), so opencode's controlling
 * instructions reach the agent without being flattened into the untrusted
 * user-message transcript (which injection-hardened models reject). Returns true
 * when a rule was written; a no-op (false) for empty text.
 */
export function writeSystemRule(cwd: string, systemText: string): boolean {
	if (!systemText) return false;
	const dir = join(cwd, RULES_DIR);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, RULE_FILE),
		`---\nalwaysApply: true\n---\n\n${systemText}\n`,
		"utf8",
	);
	ensureGitIgnored(dir);
	return true;
}

/** Keep the generated rule out of git via `.cursor/rules/.gitignore`. */
function ensureGitIgnored(dir: string): void {
	const path = join(dir, IGNORE_FILE);
	const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
	if (existing.split(/\r?\n/).includes(RULE_FILE)) return;
	const prefix =
		existing && !existing.endsWith("\n") ? `${existing}\n` : existing;
	writeFileSync(path, `${prefix}${RULE_FILE}\n`, "utf8");
}

/** Remove the generated rule (best-effort); used on plugin dispose. */
export function removeSystemRule(cwd: string): void {
	try {
		rmSync(join(cwd, RULES_DIR, RULE_FILE));
	} catch {
		// best effort — already gone or never written
	}
}
