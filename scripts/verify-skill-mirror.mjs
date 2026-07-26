// Standalone verification: exercises the full skill discovery + mirror pipeline
// against the real skills on this machine, without needing opencode or a Cursor
// API key. Read-only against real skills; writes only to a temp dir.
//
// Run: npx tsx scripts/verify-skill-mirror.mjs
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";

const { discoverSkills, resolveSkills, skillSetHash } = await import(
	"../src/plugin/skill-discovery.ts"
);
const { writeSkillMirror, removeSkillMirror, buildSkillsCatalogue } = await import(
	"../src/provider/skill-mirror.ts"
);

// Read skills.paths from the real opencode config.
const configPath = join(homedir(), ".config", "opencode", "opencode.jsonc");
const configRaw = readFileSync(configPath, "utf8");
// Strip JSONC comments — but only // that aren't inside strings.
// Simple approach: remove // comments and /* */ comments, but preserve
// // inside quoted strings by tracking quote state.
function stripJsonc(text) {
	let result = "";
	let inString = false;
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		if (inString) {
			result += ch;
			if (ch === "\\" && i + 1 < text.length) {
				result += text[i + 1];
				i += 2;
				continue;
			}
			if (ch === '"') inString = false;
			i++;
			continue;
		}
		if (ch === '"') {
			inString = true;
			result += ch;
			i++;
			continue;
		}
		if (ch === "/" && text[i + 1] === "/") {
			// Line comment — skip to end of line.
			while (i < text.length && text[i] !== "\n") i++;
			continue;
		}
		if (ch === "/" && text[i + 1] === "*") {
			// Block comment — skip to closing.
			i += 2;
			while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
			i += 2;
			continue;
		}
		result += ch;
		i++;
	}
	return result;
}
const config = JSON.parse(stripJsonc(configRaw));
const extraPaths = config.skills?.paths ?? [];

console.log("=== Skill Mirror Verification ===\n");
console.log(`Config skills.paths: ${extraPaths.length} entries`);
for (const p of extraPaths) console.log(`  - ${p}`);
console.log();

// Use the opencode config dir as cwd (where opencode actually runs).
const cwd = join(homedir(), ".config", "opencode");
console.log(`Discovery cwd: ${cwd}`);

// Layer 1: Discover skills (with extraPaths from config).
const discovered = discoverSkills(cwd, extraPaths);
console.log(`\nDiscovered: ${discovered.length} skills`);
for (const s of discovered.sort((a, b) => a.id.localeCompare(b.id))) {
	console.log(`  - ${s.id}: ${s.description.slice(0, 80)}${s.description.length > 80 ? "…" : ""}`);
}

// Layer 2: Filter through permissions.
const resolved = resolveSkills(cwd, config, undefined);
console.log(`\nAfter permission filtering: ${resolved.skills.length} permitted, ${resolved.withheld.length} withheld`);
for (const w of resolved.withheld) {
	console.log(`  WITHHELD: ${w.id} — ${w.reason}`);
}

// Layer 3: Materialise to a temp dir.
const tmpDir = mkdtempSync(join(tmpdir(), "skill-mirror-verify-"));
console.log(`\nMirror target: ${tmpDir}`);
const warnings = [];
const writeResult = writeSkillMirror(tmpDir, resolved.skills, (msg) => warnings.push(msg));
console.log(`Write result: ${writeResult}`);
if (warnings.length > 0) {
	console.log(`Warnings (${warnings.length}):`);
	for (const w of warnings) console.log(`  - ${w}`);
}

// Layer 4: Verify the mirror on disk.
const mirrorDir = join(tmpDir, ".cursor", "skills");
const mirrored = existsSync(mirrorDir) ? readdirSync(mirrorDir, { withFileTypes: true })
	.filter((e) => e.isDirectory())
	.map((e) => e.name) : [];
console.log(`\nMirrored directories: ${mirrored.length}`);
for (const id of mirrored.sort()) {
	const skillMd = join(mirrorDir, id, "SKILL.md");
	const content = readFileSync(skillMd, "utf8");
	const hasSentinel = content.includes("generated: opencode-cursor");
	console.log(`  ${id}: sentinel=${hasSentinel}`);
}

// Layer 5: Verify .gitignore.
const gitignorePath = join(mirrorDir, ".gitignore");
if (existsSync(gitignorePath)) {
	const gi = readFileSync(gitignorePath, "utf8");
	console.log(`\n.gitignore entries: ${gi.split(/\r?\n/).filter(Boolean).length}`);
	console.log(`  Contains .gitignore itself: ${gi.includes(".gitignore")}`);
}

// Layer 6: Verify the catalogue.
const catalogue = buildSkillsCatalogue(resolved.skills);
if (catalogue) {
	console.log(`\nCatalogue length: ${catalogue.length} chars`);
	console.log(`  Contains <available_skills>: ${catalogue.includes("<available_skills>")}`);
	console.log(`  Contains </available_skills>: ${catalogue.includes("</available_skills>")}`);
	const skillIdsInCatalogue = resolved.skills.filter((s) => catalogue.includes(`**${s.id}**`));
	console.log(`  Skills listed in catalogue: ${skillIdsInCatalogue.length} / ${resolved.skills.length}`);
}

// Layer 7: Verify idempotency.
const hash1 = skillSetHash(resolved.skills);
const hash2 = skillSetHash(resolved.skills);
console.log(`\nIdempotency: hash stable = ${hash1 === hash2}`);

// Layer 8: Verify dispose.
removeSkillMirror(tmpDir);
const afterDispose = existsSync(mirrorDir) ? readdirSync(mirrorDir, { withFileTypes: true })
	.filter((e) => e.isDirectory())
	.map((e) => e.name) : [];
console.log(`\nAfter removeSkillMirror: ${afterDispose.length} dirs remain`);

// Cleanup.
rmSync(tmpDir, { recursive: true, force: true });

// Summary.
console.log("\n=== Summary ===");
console.log(`Discovered:     ${discovered.length}`);
console.log(`Permitted:      ${resolved.skills.length}`);
console.log(`Withheld:       ${resolved.withheld.length}`);
console.log(`Mirrored:       ${mirrored.length}`);
console.log(`Warnings:       ${warnings.length}`);
console.log(`Dispose clean:  ${afterDispose.length === 0}`);

const allPass = discovered.length > 0
	&& resolved.skills.length === discovered.length
	&& mirrored.length === resolved.skills.length
	&& warnings.length === 0
	&& afterDispose.length === 0;

console.log(`\nResult: ${allPass ? "PASS" : "FAIL"}`);
if (!allPass) {
	console.log("  Discrepancies:");
	if (discovered.length === 0) console.log("    - No skills discovered");
	if (resolved.skills.length !== discovered.length) console.log(`    - Permission filtering changed count: ${discovered.length} -> ${resolved.skills.length}`);
	if (mirrored.length !== resolved.skills.length) console.log(`    - Mirror count mismatch: expected ${resolved.skills.length}, got ${mirrored.length}`);
	if (warnings.length > 0) console.log(`    - ${warnings.length} warnings during mirror`);
	if (afterDispose.length > 0) console.log(`    - Dispose left ${afterDispose.length} dirs`);
}
process.exit(allPass ? 0 : 1);
