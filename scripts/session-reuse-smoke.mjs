// Live smoke test for fingerprint-guarded session reuse (`session: "auto"`).
//
// Simulates how opencode drives the provider across turns: it re-sends the
// whole transcript each call with a stable providerOptions.cursor.sessionID.
// This script asserts the classification + cache behavior empirically:
//
//   Turn 1 (new)          -> fresh agent, full transcript
//   Turn 2,3 (continuation)-> RESUME pooled agent, send only the new message;
//                            inputTokens stays flat, cacheRead dominates
//   Turn 4 (divergence)   -> edit an earlier user message -> fresh replay,
//                            re-pool. Demonstrates the safety fallback.
//
// Classification is logged to stderr (OPENCODE_CURSOR_DEBUG=1, set below).
// Skips cleanly (exit 0) when CURSOR_API_KEY is absent.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OPENCODE_CURSOR_DEBUG = "1";

const apiKey = process.env.CURSOR_API_KEY?.trim();
if (!apiKey) {
	console.log("[session-smoke] No CURSOR_API_KEY; skipping.");
	process.exit(0);
}

const modelId = process.env.CURSOR_SMOKE_MODEL?.trim() || "composer-2.5";
const providerUrl = new URL("../dist/provider/index.js", import.meta.url).href;
const { createCursor } = await import(providerUrl);

const cwd = mkdtempSync(join(tmpdir(), "cursor-session-"));
const model = createCursor({ apiKey, cwd, session: "auto" }).languageModel(
	modelId,
);
const sessionID = `smoke-${Date.now()}`;

const sys = {
	role: "system",
	content: "You are terse. Answer in one short sentence.",
};
const user = (text) => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text) => ({
	role: "assistant",
	content: [{ type: "text", text }],
});

async function turn(label, prompt) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 180_000);
	let text = "";
	let usage;
	try {
		const { stream } = await model.doStream({
			prompt,
			abortSignal: controller.signal,
			providerOptions: { cursor: { sessionID } },
		});
		const reader = stream.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value.type === "text-delta") text += value.delta;
			else if (value.type === "finish") usage = value.usage;
		}
	} finally {
		clearTimeout(timer);
	}
	const inp = usage?.inputTokens ?? {};
	console.log(
		`[session-smoke:${label}] reply=${JSON.stringify(text.trim().slice(0, 60))} ` +
			`input=${inp.total ?? "?"} cacheRead=${inp.cacheRead ?? "?"} cacheWrite=${inp.cacheWrite ?? "?"}`,
	);
	return text.trim();
}

// Turn 1 — new session.
const r1 = await turn("t1-new", [sys, user("Name a primary color.")]);
// Turn 2 — continuation (one new user message appended).
const r2 = await turn("t2-cont", [
	sys,
	user("Name a primary color."),
	assistant(r1),
	user("Name another one."),
]);
// Turn 3 — continuation again.
const r3 = await turn("t3-cont", [
	sys,
	user("Name a primary color."),
	assistant(r1),
	user("Name another one."),
	assistant(r2),
	user("And a third?"),
]);
// Turn 4 — divergence: edit the FIRST user message -> must fall back to replay.
await turn("t4-diverge", [
	sys,
	user("Name a primary color. (edited)"),
	assistant(r1),
	user("Name another one."),
	assistant(r2),
	user("And a third?"),
	assistant(r3),
	user("One more?"),
]);

console.log(
	"[session-smoke] Done. Expect stderr classifications: " +
		"fresh:new, resume, resume, fresh:divergence. " +
		"On t2/t3 inputTokens should stay flat with cacheRead dominating.",
);
