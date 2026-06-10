// Live end-to-end smoke test for the Cursor provider's streaming path.
//
// Exercises the REAL agent plumbing the controls/MCP wiring builds on:
//   createCursor().languageModel().doStream()  ->  runCursorAgent()
//   ->  @cursor/sdk Agent.create / agent.send (live local agent)
//   ->  onDelta callbacks  ->  AI-SDK stream parts.
//
// Round 1: a default turn (asserts assistant text comes back).
// Round 2: a per-request control via providerOptions ({ cursor: { mode: "plan" } })
//          to verify control delivery reaches Agent.create without error.
//
// Skips cleanly (exit 0) when CURSOR_API_KEY is absent.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const apiKey = process.env.CURSOR_API_KEY?.trim();
if (!apiKey) {
  console.log("[live-chat] No CURSOR_API_KEY; skipping live chat smoke test.");
  process.exit(0);
}

const modelId = process.env.CURSOR_SMOKE_MODEL?.trim() || "composer-2.5";
const providerUrl = new URL("../dist/provider/index.js", import.meta.url).href;
const { createCursor } = await import(providerUrl);

// Run the local agent in an empty throwaway dir so it has nothing to act on.
const cwd = mkdtempSync(join(tmpdir(), "cursor-live-"));
const model = createCursor({ apiKey, cwd }).languageModel(modelId);

const prompt = [
  {
    role: "user",
    content: [{ type: "text", text: "Reply with exactly the single word PONG and nothing else." }],
  },
];

async function runOnce(label, callOptions) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000);
  const seen = [];
  let text = "";
  let finish;
  let streamError;
  try {
    const { stream } = await model.doStream({ prompt, abortSignal: controller.signal, ...callOptions });
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      seen.push(value.type);
      if (value.type === "text-delta") text += value.delta;
      else if (value.type === "finish") finish = value;
      else if (value.type === "error") streamError = value.error;
    }
  } catch (err) {
    streamError = err;
  } finally {
    clearTimeout(timer);
  }
  console.log(`[live-chat:${label}] parts: ${seen.join(", ")}`);
  console.log(`[live-chat:${label}] text: ${JSON.stringify(text.trim().slice(0, 120))}`);
  if (finish) console.log(`[live-chat:${label}] finish: ${JSON.stringify(finish.finishReason)} usage=${JSON.stringify(finish.usage)}`);
  if (streamError) {
    const detail = streamError instanceof Error ? `${streamError.message}\n${streamError.stack}` : JSON.stringify(streamError);
    console.error(`[live-chat:${label}] stream error: ${detail}`);
    return { ok: false, text };
  }
  return { ok: true, text };
}

// Round 1 — default turn; must produce assistant text.
const base = await runOnce("default", {});
if (!base.ok || !base.text.trim()) {
  console.error("[live-chat] FAIL: default turn returned no assistant text.");
  process.exit(1);
}

// Round 2 — per-request control delivery (plan mode via providerOptions).
const plan = await runOnce("plan-mode", { providerOptions: { cursor: { mode: "plan" } } });
if (!plan.ok) {
  console.error("[live-chat] FAIL: plan-mode control turn errored.");
  process.exit(1);
}

console.log("[live-chat] PASS: live agent streamed text and accepted a per-request control.");
