# opencode Controls Cursor via the Rules Channel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver opencode's system prompt to the Cursor agent through Cursor's **authoritative rules channel** (`.cursor/rules/*.mdc` loaded via `settingSources`) instead of flattening it into the user-message transcript — so opencode genuinely controls the Cursor agent AND the content is no longer rejected as a prompt-injection attempt.

**Architecture:** Add a `systemPrompt` provider option (`"rules"` default | `"message"` legacy | `"omit"`). In `"rules"` mode the plugin writes opencode's system prompt to a git-ignored `<cwd>/.cursor/rules/opencode.mdc` with `alwaysApply: true`, ensures the Cursor agent loads the `project` settings layer, and stops emitting the system prompt into the flattened transcript. Rules load from disk at `Agent.create`, so both the in-process and sidecar backends work unchanged (no RPC protocol change).

**Tech Stack:** TypeScript, `@ai-sdk/provider` (`LanguageModelV3Prompt`), `@cursor/sdk` 1.0.x (`settingSources`, local agents), Node `fs`, Vitest, tsup.

---

## Why this design (verified findings)

- **The intent:** opencode-cursor makes Cursor a **provider** — "you chat with them the same way you use any other provider" (`README.md:7`). A provider is steered by the host's system prompt. So "opencode controls Cursor" requires opencode's system prompt to reach Cursor authoritatively.
- **The SDK has no system-prompt input** — confirmed through the latest `@cursor/sdk@1.0.22`. `AgentOptions` / `LocalAgentOptions` / `SendOptions` expose `model`, `mode`, `mcpServers`, `agents`, `settingSources`, `customTools`, `sandboxOptions`, `autoReview` — **no** `systemPrompt`/`instructions` field. The SDK hands you a complete agent (Composer with its own harness prompt), not a raw model.
- **Cursor's documented channel for system-level instructions is rules.** Cursor docs: *"Rules provide system-level instructions to Agent … included at the start of the model context."* A `.cursor/rules/*.mdc` file with `alwaysApply: true` is applied to every session. Loaded via `local.settingSources` including `"project"`.
- **Current bug:** `src/provider/message-map.ts:47-49` flattens opencode's `role:"system"` message into the body of a `role:"user"` message. Cursor's agent already has its own system prompt, so this arrives as a rival, injection-shaped directive through the *untrusted user channel* — and Cursor's injection-hardened models reject it (the "you're prompt-injecting / gaslighting me" behavior). Cursor also strips authoritative-looking tags (`rules`, `system_reminder`, …) from message content, so in-message delivery can never be made authoritative.
- **Rules load from disk → no sidecar change.** `acquireAgent` (`src/provider/session-pool.ts:101-136`) already threads `settingSources` into `createOptions.local` for both backends (`src/provider/agent-backend.ts`). We only need to (a) write the file and (b) ensure `settingSources` includes `"project"`.
- **Session reuse is unaffected:** `classifyTurn`/`fingerprint` hash `options.prompt` (`src/provider/transcript-fingerprint.ts:80-92`), not what we send. The rule content equals the system prompt; when the system prompt changes, `systemHash` changes and the pool already forces a fresh agent — which re-reads the rewritten rule at create time.

### Known tradeoffs (documented, not blockers)

- A `project` rule at `.cursor/rules/opencode.mdc` **also applies to the user's own Cursor IDE** in that repo. Inherent to the only authoritative channel Cursor exposes. Mitigated by best-effort cleanup on dispose + the `"message"`/`"omit"` escapes.
- Enabling the `"project"` settings layer to load our rule **also loads other project `.cursor/` config** (`.cursor/mcp.json`, `.cursor/agents`, hooks). Documented; `forwardMcp` already handles opencode's MCP set, so users who don't want project MCP can keep `systemPrompt: "message"`/`"omit"`.
- Concurrent opencode sessions in the same repo share one `opencode.mdc` (last write wins; content is opencode's own prompt, so overlap is benign). Cleanup on dispose is best-effort.

## File Structure

- Create: `src/provider/system-rule.ts` — extract system text; write/remove the `.cursor/rules/opencode.mdc` rule; keep it git-ignored.
- Modify: `src/provider/message-map.ts` — `SystemPromptMode` type; `systemPrompt` param; only emit `# System` in `"message"` mode.
- Modify: `src/provider/language-model.ts` — `systemPrompt` in `CursorModelConfig`; in `"rules"` mode write the rule + add `"project"` to `settingSources`; pass mode to `promptToCursorMessage`.
- Modify: `src/provider/index.ts` — `systemPrompt` in `CursorProviderOptions`; default `"rules"`.
- Modify: `src/plugin/index.ts` — `dispose` hook removes the generated rule (best-effort).
- Test: `test/system-rule.test.ts` (new); `test/message-map.test.ts` (update).
- Modify: `README.md`, `CHANGELOG.md`.

---

### Task 1: `system-rule.ts` — write opencode's prompt as a Cursor rule

**Files:**
- Create: `src/provider/system-rule.ts`
- Test: `test/system-rule.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/system-rule.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/system-rule.test.ts`
Expected: FAIL — `../src/provider/system-rule.js` does not exist.

- [ ] **Step 3: Implement `src/provider/system-rule.ts`**

```ts
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
	const prefix = existing && !existing.endsWith("\n") ? `${existing}\n` : existing;
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
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/system-rule.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/provider/system-rule.ts test/system-rule.test.ts
git commit -m "feat(provider): materialize opencode system prompt as a Cursor rule"
```

---

### Task 2: `systemPrompt` mode in `promptToCursorMessage`

**Files:**
- Modify: `src/provider/message-map.ts`
- Test: `test/message-map.test.ts`

- [ ] **Step 1: Update tests (fail first)**

In `test/message-map.test.ts`, REPLACE the first test (`it("flattens a multi-role conversation into a transcript", ...)`, lines 9-22) with these three:

```ts
	it("omits the system prompt from the transcript by default (rules mode)", () => {
		const prompt: LanguageModelV3Prompt = [
			{ role: "system", content: "Be concise." },
			{ role: "user", content: [{ type: "text", text: "Hello" }] },
			{ role: "assistant", content: [{ type: "text", text: "Hi there" }] },
			{ role: "user", content: [{ type: "text", text: "What is 2+2?" }] },
		];
		const msg = promptToCursorMessage(prompt);
		// System prompt is delivered via the Cursor rules channel, not inline.
		expect(msg.text).not.toContain("# System");
		expect(msg.text).not.toContain("Be concise.");
		expect(msg.text).toContain("# User\nHello");
		expect(msg.text).toContain("# Assistant\nHi there");
		expect(msg.text).toContain("# User\nWhat is 2+2?");
		expect(msg.images).toBeUndefined();
	});

	it("includes the system prompt inline in 'message' (legacy) mode", () => {
		const prompt: LanguageModelV3Prompt = [
			{ role: "system", content: "Be concise." },
			{ role: "user", content: [{ type: "text", text: "Hi" }] },
		];
		const msg = promptToCursorMessage(prompt, "message");
		expect(msg.text).toContain("# System\nBe concise.");
	});

	it("omits the system prompt in 'omit' mode", () => {
		const prompt: LanguageModelV3Prompt = [
			{ role: "system", content: "Be concise." },
			{ role: "user", content: [{ type: "text", text: "Hi" }] },
		];
		const msg = promptToCursorMessage(prompt, "omit");
		expect(msg.text).not.toContain("Be concise.");
		expect(msg.text).toBe("# User\nHi");
	});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/message-map.test.ts`
Expected: FAIL — default still emits `# System`; `promptToCursorMessage(prompt, "message")` is an arity error.

- [ ] **Step 3: Implement**

In `src/provider/message-map.ts`, add after the imports (after line 2):

```ts
/**
 * How opencode's system prompt reaches the Cursor agent.
 *  - "rules" (default): delivered out-of-band as a Cursor project rule
 *    (see system-rule.ts) and therefore omitted from this flattened transcript.
 *  - "message": legacy — inlined as a `# System` block in the transcript.
 *    Injection-hardened Cursor models may reject this; kept for back-compat.
 *  - "omit": dropped entirely (no rule, no inline).
 */
export type SystemPromptMode = "rules" | "message" | "omit";
```

Change the signature (lines 38-40):

```ts
export function promptToCursorMessage(
	prompt: LanguageModelV3Prompt,
	systemPrompt: SystemPromptMode = "rules",
): SDKUserMessage {
```

Replace the `case "system":` block (lines 47-49):

```ts
			case "system":
				// Only inline in legacy "message" mode. In "rules" mode the system
				// prompt is delivered via .cursor/rules (authoritative, not flagged);
				// in "omit" mode it is dropped.
				if (systemPrompt === "message") {
					lines.push(`# System\n${message.content}`);
				}
				break;
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/message-map.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/provider/message-map.ts test/message-map.test.ts
git commit -m "feat(provider): systemPrompt modes (rules|message|omit) in transcript mapping"
```

---

### Task 3: Wire the rules channel into the turn (language-model.ts)

**Files:**
- Modify: `src/provider/language-model.ts`

Behavior covered by Task 1/2 unit tests + typecheck; this is wiring.

- [ ] **Step 1: Imports + config field**

In `src/provider/language-model.ts`, update the message-map import (line 17):

```ts
import {
	latestUserMessage,
	promptToCursorMessage,
	type SystemPromptMode,
} from "./message-map.js";
```

Add below it:

```ts
import { extractSystemText, writeSystemRule } from "./system-rule.js";
```

Add to `CursorModelConfig` (after the `toolDisplay` field, ~line 66):

```ts
	/**
	 * How opencode's system prompt reaches the Cursor agent (see
	 * {@link SystemPromptMode}). Defaults to "rules".
	 */
	systemPrompt?: SystemPromptMode;
```

- [ ] **Step 2: Materialize the rule + enable the project layer**

In `agentRun`, immediately BEFORE the `const acquired = await acquireAgent({` call (currently line 187), insert:

```ts
		// In "rules" mode (default), deliver opencode's system prompt through
		// Cursor's authoritative rules channel instead of the user transcript.
		const systemMode: SystemPromptMode = this.config.systemPrompt ?? "rules";
		let settingSources = this.config.settingSources;
		if (systemMode === "rules") {
			const systemText = extractSystemText(options.prompt);
			if (writeSystemRule(this.config.cwd, systemText)) {
				settingSources =
					settingSources?.includes("project")
						? settingSources
						: [...(settingSources ?? []), "project"];
			}
		}
```

Then, in that same `acquireAgent({ ... })` call, replace the existing settingSources spread (currently lines 192-194):

```ts
			...(settingSources ? { settingSources } : {}),
```

- [ ] **Step 3: Pass the mode to the transcript mapper**

Replace the message construction (currently lines 208-211):

```ts
		const message = acquired.resumed
			? (latestUserMessage(options.prompt) ??
				promptToCursorMessage(options.prompt, systemMode))
			: promptToCursorMessage(options.prompt, systemMode);
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/provider/language-model.ts
git commit -m "feat(provider): deliver system prompt via Cursor rules in rules mode"
```

---

### Task 4: Public option + dispose cleanup

**Files:**
- Modify: `src/provider/index.ts`
- Modify: `src/plugin/index.ts`

- [ ] **Step 1: Add the option in `provider/index.ts`**

Add import after line 18 (`import type { ToolDisplay } ...`):

```ts
import type { SystemPromptMode } from "./message-map.js";
```

Add to `CursorProviderOptions` (after the `toolDisplay` field, ~line 67):

```ts
	/**
	 * How opencode's system prompt reaches the Cursor agent:
	 *  - "rules" (default): written to `<cwd>/.cursor/rules/opencode.mdc`
	 *    (git-ignored, alwaysApply) and loaded via the `project` settings layer —
	 *    Cursor's authoritative channel, so it is not rejected as prompt injection.
	 *    Note: a project rule also applies to your own Cursor IDE in this repo, and
	 *    enabling the project layer also loads other `.cursor/` config.
	 *  - "message": legacy inline `# System` block (may be flagged as injection).
	 *  - "omit": not forwarded at all.
	 */
	systemPrompt?: SystemPromptMode;
```

Add the default into the `config` object in `createCursor` (alongside `toolDisplay`, ~line 96):

```ts
		systemPrompt: options.systemPrompt ?? "rules",
```

- [ ] **Step 2: Remove the rule on dispose**

In `src/plugin/index.ts`, add the import near the top (after line 12):

```ts
import { removeSystemRule } from "../provider/system-rule.js";
```

In the returned hooks object (the `return { auth: {...}, config: ..., provider: ..., ... }`), add a `dispose` hook. Add this property to that returned object:

```ts
		dispose: async () => {
			// Best-effort: drop the generated system-prompt rule so it doesn't
			// linger in the user's workspace / Cursor IDE after the session ends.
			if (directory) removeSystemRule(directory);
		},
```

- [ ] **Step 3: Typecheck + full test suite**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/provider/index.ts src/plugin/index.ts
git commit -m "feat(provider): systemPrompt option (default rules) + dispose cleanup"
```

---

### Task 5: Docs + Changelog

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: README config-table row**

In `README.md`, add after the `toolDisplay` row (line 126):

```
| `systemPrompt` | `"rules"` | How opencode's system prompt reaches the agent — see [System prompt](#system-prompt) |
```

- [ ] **Step 2: README "System prompt" section**

Insert immediately BEFORE `## MCP servers` (line 177):

```markdown
## System prompt

opencode drives the Cursor agent the way it drives any provider — through its
**system prompt**. But the Cursor SDK has no system-prompt input (an agent, not a
raw model), and flattening opencode's system prompt into the message stream makes
injection-hardened Cursor models reject it as a prompt-injection attempt.

So by default (`systemPrompt: "rules"`) the plugin writes opencode's system prompt
to `<cwd>/.cursor/rules/opencode.mdc` (`alwaysApply: true`, git-ignored) and loads
the `project` settings layer, delivering it through Cursor's **authoritative rules
channel**. Cursor treats rules as system-level instructions, so opencode stays in
control and nothing is flagged.

Tradeoffs to know:

- A project rule also applies to **your own Cursor IDE** open on this repo. The
  plugin removes the file when the session disposes (best-effort).
- Enabling the `project` layer also loads other `.cursor/` config (`.cursor/mcp.json`,
  `.cursor/agents`, hooks).

Alternatives:

- `systemPrompt: "message"` — legacy inline delivery (may be rejected as injection).
- `systemPrompt: "omit"` — don't forward the system prompt at all.

* * *
```

- [ ] **Step 3: README security bullet**

In `## Security`, after the existing option bullets (ending line 108):

```
> - By default opencode's system prompt is delivered via a git-ignored Cursor
>   rule (`systemPrompt: "rules"`), not inlined into the message stream. See
>   [System prompt](#system-prompt).
```

- [ ] **Step 4: CHANGELOG**

In `CHANGELOG.md`, replace line 7 (`_No unreleased changes._`) with:

```markdown
- **Fixed: Cursor agent rejecting turns as "prompt injection" / "gaslighting."**
  The provider flattened opencode's system prompt into the user-message transcript;
  Cursor's agent (which has its own system prompt) treated that as an injection
  attempt. opencode's system prompt is now delivered through Cursor's authoritative
  rules channel — written to a git-ignored `.cursor/rules/opencode.mdc` and loaded
  via `settingSources` — so opencode keeps control without being flagged. New
  `systemPrompt` option: `"rules"` (default), `"message"` (legacy inline), `"omit"`.
```

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: document systemPrompt rules-channel delivery"
```

---

### Task 6: Full verification

- [ ] **Step 1: Gate commands (must be green)**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck clean; all Vitest files pass; tsup build succeeds.

- [ ] **Step 2: No stray inline system forwarding by default**

Run: `rg -n "# System" src`
Expected: only the `"message"`-mode branch in `src/provider/message-map.ts`.

- [ ] **Step 3 (optional): E2E smoke**

Run: `bash scripts/integration-test.sh`
Expected: `opencode models` lists `cursor/*`. Skip if opencode CLI isn't installed.

---

## Self-review notes

- Types consistent: `SystemPromptMode` defined in `message-map.ts`, imported by `language-model.ts` and `provider/index.ts`; default `"rules"` applied in `createCursor` and defensively in `agentRun`.
- No sidecar/RPC changes — rules load from disk at `Agent.create`, exercised identically by both backends.
- Session pooling untouched: fingerprint reads `options.prompt`; rule content tracks the system prompt, which already drives fresh-vs-resume.
- Escape hatches (`"message"`, `"omit"`) preserve prior behavior for anyone who needs it.
