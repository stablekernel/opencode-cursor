import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import type { SDKUserMessage } from "@cursor/sdk";

// Mock homedir so self-provisioning doesn't pick up real global skills.
const fakeHome = mkdtempSync(join(tmpdir(), "cursor-lm-home-"));
vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	return { ...actual, homedir: () => fakeHome };
});

const acquireAgent = vi.fn();
const streamAgentTurn = vi.fn();

// Mock the agent runtime boundary so no live Cursor agent is ever spawned.
vi.mock("../src/provider/session-pool.js", () => ({
	acquireAgent: (...args: unknown[]) => acquireAgent(...args),
	getSessionRecord: () => undefined,
	withSessionLock: (_sessionID: unknown, fn: () => Promise<unknown>) => fn(),
}));
vi.mock("../src/provider/agent-events.js", () => ({
	streamAgentTurn: (...args: unknown[]) => streamAgentTurn(...args),
}));

const { CursorLanguageModel } = await import(
	"../src/provider/language-model.js"
);
type ModelConfig = ConstructorParameters<typeof CursorLanguageModel>[1];

const dirs: string[] = [];
function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), "cursor-lm-"));
	dirs.push(d);
	return d;
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
	acquireAgent.mockImplementation(async () => ({
		agent: {},
		resumed: false,
		release: () => {},
	}));
	streamAgentTurn.mockImplementation(() => (async function* () {})());
});

afterEach(() => {
	warnSpy.mockRestore();
	acquireAgent.mockReset();
	streamAgentTurn.mockReset();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function model(config: Partial<ModelConfig> & { cwd: string }) {
	return new CursorLanguageModel("composer-2.5", {
		providerName: "cursor",
		apiKey: "test-key",
		mode: "agent",
		session: false,
		...config,
	} as ModelConfig);
}

const options = {
	prompt: [
		{ role: "system", content: "SYS PROMPT" },
		{ role: "user", content: [{ type: "text", text: "hi" }] },
	],
} as unknown as LanguageModelV3CallOptions;

function acquiredSettingSources(): unknown {
	expect(acquireAgent).toHaveBeenCalledOnce();
	return (acquireAgent.mock.calls[0]![0] as Record<string, unknown>)[
		"settingSources"
	];
}

function sentMessage(): SDKUserMessage {
	expect(streamAgentTurn).toHaveBeenCalledOnce();
	return streamAgentTurn.mock.calls[0]![1] as SDKUserMessage;
}

function rulePath(cwd: string): string {
	return join(cwd, ".cursor", "rules", "opencode.mdc");
}

describe("CursorLanguageModel system prompt delivery (rules mode)", () => {
	it("writes the rule and enables the project layer when settingSources is not configured", async () => {
		const cwd = tmp();
		await model({ cwd }).doGenerate(options);
		expect(acquiredSettingSources()).toEqual(["project"]);
		expect(readFileSync(rulePath(cwd), "utf8")).toContain("SYS PROMPT");
		expect(sentMessage().text).not.toContain("# System");
	});

	it("keeps user-configured settingSources that already include project", async () => {
		const cwd = tmp();
		await model({ cwd, settingSources: ["user", "project"] }).doGenerate(
			options,
		);
		expect(acquiredSettingSources()).toEqual(["user", "project"]);
		expect(existsSync(rulePath(cwd))).toBe(true);
	});

	it("respects an explicit settingSources opt-out of project: falls back to message mode without mutating the list", async () => {
		const cwd = tmp();
		await model({ cwd, settingSources: ["user"] }).doGenerate(options);
		expect(acquiredSettingSources()).toEqual(["user"]);
		expect(existsSync(rulePath(cwd))).toBe(false);
		expect(sentMessage().text).toContain("# System\nSYS PROMPT");
		expect(warnSpy).toHaveBeenCalled();
	});

	it("warns only once for a repeated settingSources opt-out", async () => {
		const cwd = tmp();
		const m = model({ cwd, settingSources: ["user"] });
		await m.doGenerate(options);
		await m.doGenerate(options);
		expect(warnSpy).toHaveBeenCalledTimes(1);
	});

	it("degrades to message mode for the turn when the rule write fails", async () => {
		const cwd = tmp();
		// Make the write fail: `.cursor` exists as a FILE, so mkdir/write throws.
		writeFileSync(join(cwd, ".cursor"), "not a dir", "utf8");
		await model({ cwd }).doGenerate(options);
		expect(acquiredSettingSources()).toBeUndefined();
		expect(sentMessage().text).toContain("# System\nSYS PROMPT");
		expect(warnSpy).toHaveBeenCalled();
	});

	it("degrades to message mode when opencode.mdc is user-owned (no sentinel)", async () => {
		const cwd = tmp();
		const dir = join(cwd, ".cursor", "rules");
		mkdirSync(dir, { recursive: true });
		const userBody = "---\nalwaysApply: true\n---\n\nMy own rule.\n";
		writeFileSync(join(dir, "opencode.mdc"), userBody, "utf8");
		await model({ cwd }).doGenerate(options);
		expect(readFileSync(rulePath(cwd), "utf8")).toBe(userBody);
		expect(acquiredSettingSources()).toBeUndefined();
		expect(sentMessage().text).toContain("# System\nSYS PROMPT");
		expect(warnSpy).toHaveBeenCalled();
	});
});

describe("CursorLanguageModel system prompt delivery (message/omit modes)", () => {
	it("message mode inlines the system prompt and never writes the rule file", async () => {
		const cwd = tmp();
		await model({ cwd, systemPrompt: "message" }).doGenerate(options);
		expect(existsSync(rulePath(cwd))).toBe(false);
		expect(acquiredSettingSources()).toBeUndefined();
		expect(sentMessage().text).toContain("# System\nSYS PROMPT");
	});

	it("omit mode drops the system prompt and never writes the rule file", async () => {
		const cwd = tmp();
		await model({ cwd, systemPrompt: "omit" }).doGenerate(options);
		expect(existsSync(rulePath(cwd))).toBe(false);
		expect(acquiredSettingSources()).toBeUndefined();
		expect(sentMessage().text).not.toContain("SYS PROMPT");
	});

	it("message mode leaves user-configured settingSources untouched", async () => {
		const cwd = tmp();
		await model({
			cwd,
			systemPrompt: "message",
			settingSources: ["user"],
		}).doGenerate(options);
		expect(acquiredSettingSources()).toEqual(["user"]);
		expect(existsSync(rulePath(cwd))).toBe(false);
	});
});

describe("CursorLanguageModel skills catalogue in system rule", () => {
	it("appends the static catalogue from config to the rule file", async () => {
		const cwd = tmp();
		const catalogue = "<available_skills>\n- **test-skill**: A test.\n</available_skills>";
		await model({ cwd, skillsCatalogue: catalogue }).doGenerate(options);
		const rule = readFileSync(rulePath(cwd), "utf8");
		expect(rule).toContain("SYS PROMPT");
		expect(rule).toContain("<available_skills>");
		expect(rule).toContain("test-skill");
	});

	it("appends the dynamic catalogue from providerOptions, overriding the static one", async () => {
		const cwd = tmp();
		const staticCat = "<available_skills>\n- **static**: Static.\n</available_skills>";
		const dynamicCat = "<available_skills>\n- **dynamic**: Dynamic.\n</available_skills>";
		const opts = {
			...options,
			providerOptions: { cursor: { skillsCatalogue: dynamicCat } },
		} as unknown as LanguageModelV3CallOptions;
		await model({ cwd, skillsCatalogue: staticCat }).doGenerate(opts);
		const rule = readFileSync(rulePath(cwd), "utf8");
		expect(rule).toContain("dynamic");
		expect(rule).not.toContain("static");
	});

	it("uses the dynamic catalogue when no static catalogue is configured", async () => {
		const cwd = tmp();
		const dynamicCat = "<available_skills>\n- **dyn-only**: Only dynamic.\n</available_skills>";
		const opts = {
			...options,
			providerOptions: { cursor: { skillsCatalogue: dynamicCat } },
		} as unknown as LanguageModelV3CallOptions;
		await model({ cwd }).doGenerate(opts);
		const rule = readFileSync(rulePath(cwd), "utf8");
		expect(rule).toContain("dyn-only");
	});

	it("writes no catalogue section when neither static nor dynamic is set", async () => {
		const cwd = tmp();
		await model({ cwd }).doGenerate(options);
		const rule = readFileSync(rulePath(cwd), "utf8");
		expect(rule).not.toContain("<available_skills>");
		expect(rule).toContain("SYS PROMPT");
	});

	it("updates the rule when the catalogue changes between turns", async () => {
		const cwd = tmp();
		const m = model({ cwd });
		await m.doGenerate(options);
		const rule1 = readFileSync(rulePath(cwd), "utf8");
		expect(rule1).not.toContain("<available_skills>");

		const catalogue = "<available_skills>\n- **new-skill**: New.\n</available_skills>";
		const opts = {
			...options,
			providerOptions: { cursor: { skillsCatalogue: catalogue } },
		} as unknown as LanguageModelV3CallOptions;
		await m.doGenerate(opts);
		const rule2 = readFileSync(rulePath(cwd), "utf8");
		expect(rule2).toContain("<available_skills>");
		expect(rule2).toContain("new-skill");
	});

	it("does not bypass plugin filtering by discovering skills in the provider", async () => {
		const cwd = tmp();
		// A filesystem skill alone must not bypass the plugin's catalogue filtering.
		const skillDir = join(cwd, ".opencode", "skills", "self-prov-test");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			"---\nname: self-prov-test\ndescription: Self-provisioned skill.\n---\n\nBody.\n",
			"utf8",
		);
		await model({ cwd }).doGenerate(options);
		const rule = readFileSync(rulePath(cwd), "utf8");
		expect(rule).not.toContain("<available_skills>");
		expect(rule).not.toContain("self-prov-test");
	});
});
