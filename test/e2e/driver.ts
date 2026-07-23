/**
 * E2E driver — runs under Bun (opencode's runtime) and exercises the provider
 * in-process exactly as opencode's plugin host would. NDJSON events on stdout.
 *
 * Usage: bun test/e2e/driver.ts <scenario>
 * Scenarios: tool-parity | resume | long-stream | web-search | stall-cancel
 * Env: CURSOR_API_KEY (required), CURSOR_E2E_MODEL, OPENCODE_CURSOR_TRANSPORT.
 */
import { createCursor } from "../../src/provider/index.js";

const scenario = process.argv[2];
const model = process.env.CURSOR_E2E_MODEL ?? "auto";
const apiKey = process.env.CURSOR_API_KEY;
if (!apiKey) {
  console.error("CURSOR_API_KEY required");
  process.exit(2);
}

const provider = createCursor({ cwd: process.cwd(), apiKey });
const lm = provider.languageModel(model);

function emit(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function userPrompt(text: string): unknown {
  return [{ role: "user", content: [{ type: "text", text }] }];
}

interface RunSummary {
  ev: "run";
  firstDeltaMs?: number;
  deltaChars: number;
  parts: Array<{ type: string; name?: string; id?: string; isError?: boolean }>;
  error?: string;
}

async function runOnce(text: string, sessionID?: string, abortMs?: number): Promise<RunSummary> {
  const t0 = Date.now();
  let firstDeltaMs: number | undefined;
  let deltaChars = 0;
  const parts: RunSummary["parts"] = [];
  const ac = new AbortController();
  if (abortMs) setTimeout(() => ac.abort(), abortMs);
  try {
    const { stream } = await lm.doStream({
      prompt: userPrompt(text),
      ...(ac.signal ? { abortSignal: ac.signal } : {}),
      providerOptions: { cursor: { ...(sessionID ? { sessionID } : {}) } },
    } as never);
    const reader = (stream as ReadableStream<{ type: string; [k: string]: unknown }>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (
        firstDeltaMs === undefined &&
        (value.type === "text-delta" || value.type === "reasoning-delta")
      ) {
        firstDeltaMs = Date.now() - t0;
      }
      if (value.type === "text-delta") deltaChars += String(value.delta ?? "").length;
      const part: RunSummary["parts"][number] = { type: value.type };
      if (value.type === "tool-call" || value.type === "tool-result") {
        part.name = value.toolName as string | undefined;
        part.id = value.toolCallId as string | undefined;
        part.isError = value.isError as boolean | undefined;
      }
      if (value.type === "error") part.name = String(value.error ?? "");
      parts.push(part);
    }
  } catch (err) {
    return { ev: "run", deltaChars, parts, error: err instanceof Error ? err.message : String(err) };
  }
  const summary: RunSummary = { ev: "run", deltaChars, parts };
  if (firstDeltaMs !== undefined) summary.firstDeltaMs = firstDeltaMs;
  return summary;
}

switch (scenario) {
  case "tool-parity":
    emit(await runOnce(
      "Use your read tool to read package.json, then use your file-writing tool to create e2e-tmp.txt containing the word hello, then reply with exactly: DONE",
    ));
    break;
  case "resume": {
    const sessionID = `e2e-${Date.now()}`;
    emit(await runOnce("Create e2e-tmp.txt containing the word hello via your file-writing tool, then reply exactly: DONE", sessionID));
    emit(await runOnce("What single word does e2e-tmp.txt contain? Answer with just that word.", sessionID));
    break;
  }
  case "long-stream":
    emit(await runOnce(
      "Output a numbered list from 1 to 400, each line being 'NNN: the quick brown fox jumps over the lazy dog'. No commentary, just the list.",
    ));
    break;
  case "web-search":
    emit(await runOnce("Search the web for the current UTC date, then answer with just the date."));
    break;
  case "stall-cancel": {
    const sessionID = `e2e-${Date.now()}`;
    emit(await runOnce("Count slowly from 1 to 100 with a short sentence per number.", sessionID, 3_000));
    // The aborted run above may leave the agent wedged; the next send must recover.
    emit(await runOnce("Reply with exactly: RECOVERED", sessionID));
    break;
  }
  default:
    console.error(`unknown scenario "${scenario}"`);
    process.exit(2);
}
