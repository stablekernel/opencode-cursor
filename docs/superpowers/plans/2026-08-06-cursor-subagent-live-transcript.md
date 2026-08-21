# Cursor Subagent Live Transcript Implementation Plan

> **SUPERSEDED 2026-08-21.** The premise below — "Cursor's SDK emits no nested
> stream events for local subagents" — was falsified empirically: the SDK's
> `tool-call-delta` interaction update carries `taskUpdate` nested events
> (tool-start/tool-result with id+name+input) **live, mid-run**. Tool parts are
> now driven from those events in `SubagentTranscriptSink.push()`
> (subagent-stream.ts). The transcript-tail machinery (subagent-activity.ts,
> cursor-transcript.ts) was deleted: prompt-matching couldn't work (task input
> often has no `prompt`; Cursor rephrases `user_query`) and short subagents
> checkpoint only at completion (first write lands seconds after the stop
> signal). Kept from this plan: child-parts.ts (upsert incl. the required
> `state.metadata` on completed parts), the running-task stamp, the live
> child-session link. Also learned: hey-api `_client.request` resolves
> `{error}` on 4xx instead of throwing.
> See docs/superpowers/plans/2026-08-21-opencode-subagent-view-source-findings.md.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a Cursor subagent's `task` card behave like a native opencode subagent card — clickable while running, with a live `↳ <Tool> <title>` activity subtitle — by tailing Cursor's on-disk subagent transcript and materialising real `tool` parts in the child session.

**Architecture:** Cursor's SDK emits no nested stream events for local subagents, so live activity cannot come from the provider stream. It *is* written to disk: `~/.cursor/projects/<slug>/agent-transcripts/agent-<id>/subagents/<subid>.jsonl`, **rewritten in full on every checkpoint** during the run. We locate the file by matching its first line against the task prompt, poll it, and upsert opencode `tool` parts into the child session via `PATCH /session/{sid}/message/{mid}/part/{pid}` (`updatePart` is an upsert — `processor.ts:242` uses it to create parts). The TUI Task card reads exactly those parts.

**Because the file is rewritten rather than appended, the reader must track progress by completed-line count, not byte offset.** A byte-offset reader stalls permanently the first time a rewrite makes the file momentarily shorter.

**Tech Stack:** TypeScript, Node `fs`/`fs.promises`, opencode HTTP API via the SDK client's runtime `_client.request`, vitest.

## Global Constraints

- Node built-ins only; no new dependencies.
- Every write path is **best-effort**: a failure must never break the parent turn. But it must be **logged** via `pluginLog` — silent no-ops are what made the current bugs undiagnosable.
- Transcript content is **never truncated** (established decision).
- Never write to a child session after `finalize()`.
- Polling interval: 400ms. Never busy-wait.
- All new behaviour is TDD'd against fixtures captured from real files under `test/fixtures/`.

---

## Evidence This Plan Rests On

Verified by reading, with locations:

- **TUI subtitle source** — `packages/tui/src/routes/session/index.tsx:2227-2279`. `tools()` collects `type === "tool"` parts across **all** child-session messages (no role filter). `current()` = last tool part with `state.title`. Subtitle renders `↳ ${titlecase(tool)} ${title}`, else `↳ ${formatSubagentToolcalls(n)}`.
- **Card→child link** — same file, line 2220/2224: `props.metadata.sessionId`, i.e. the parent task part's `state.metadata.sessionId`.
- **`updatePart` upserts** — `packages/opencode/src/session/processor.ts:242` creates parts through `session.updatePart({id: PartID.ascending(), ...})`.
- **PATCH validation** — `httpapi/handlers/session.ts:397-411` requires `payload.id/messageID/sessionID` to equal the path params; only `requireSession` is checked.
- **No message-create endpoint** — `httpapi/groups/session.ts:111-433` exposes `updatePart`, `deletePart`, `deleteMessage`; the only message-creating routes (`prompt`, `promptAsync`, `command`, `shell`) invoke a model.
- **PartID format** — `packages/opencode/src/id/id.ts:51-70`: `prefix + "_" + 6 timestamp bytes as hex + 14 random base62`. Confirmed against real row `prt_fd90281ed001Zwm05cey7wh2ym`.
- **ToolPart shape** — `packages/opencode/src/session/prompt.ts:283-299` (running) and `:335-339` (metadata/title merge).
- **Transcript is written during the run** — `@cursor/sdk/dist/esm/357.js` @294387, inside `LocalSubagentHostAdapter`: `handleCheckpoint: (e,t) => { yield agentStore.handleCheckpoint(e,t); transcriptWriter.writeFromState(e,t) }`. `writeFromState` (@301742) calls `transcriptStore.writeFromStateFull` and then loops nested subagent states into `nestedSubagentTranscriptStore.writeFromStateFull`. So every checkpoint rewrites the subagent transcript.
- **It is a full rewrite, not an append** — the store is constructed at @301152 as `{writeText:false, writeJsonl:true, pathResolver}` with **no `appendFile`**. `writeFromStateIncremental`'s fast path requires `options.appendFile`, so it always falls back to `writeFromStateFull`.
- **Line format** — builder at @139161 emits `{role, message:{content:[{type:"text",text}|{type:"tool_use",name,input}]}}`.
- **Real transcript sample** — `agent-b6786a00-…/subagents/edf3c300-….jsonl` (the 2026-08-06 16:37 changelog run): line 0 `user` with `<user_query>`, lines 1-3 `assistant` with `text` and `tool_use` blocks (`GetMcpTools`, `Read`, `CallMcpTool`).

**Verified statically, still worth one empirical confirmation** (Task 1 Step 3): that checkpoints fire often enough mid-run to be useful. The code path is proven; the *cadence* is not.

## Implementation Status (updated during execution)

Tasks 2-6 are **implemented**; Task 1 (the live stamp fix) is **outstanding** and still gates whether any of this is visible.

Two design changes were forced during implementation, both by tests:

1. **Correlation is by mtime, not by a snapshot of pre-existing files.** The
   original `known: Set<string>` design raced: a subagent that checkpointed
   before the snapshot was taken would be excluded from matching *forever*. The
   replacement, `since: number`, rejects a previous run with the same prompt
   (Cursor never rewrites a finished subagent's transcript) without that race.
   `knownTranscripts` was removed.
2. **The reader tracks completed lines, not byte offset** — see Architecture.

Files as built: `src/provider/child-parts.ts`, `src/provider/cursor-transcript.ts`,
`src/provider/subagent-activity.ts`; modified `src/provider/subagent-bridge.ts`
and `src/provider/stream-map.ts`. Tests: `test/child-parts.test.ts`,
`test/cursor-transcript.test.ts`, `test/subagent-activity.test.ts`, plus
additions to `test/subagent-bridge.test.ts` and `test/stream-map.test.ts`.

## Known Limitation (accept or renegotiate before starting)

There is no endpoint to create an **assistant** message, so synthesized tool parts must attach to the existing user message created by the `noReply` prompt. Consequence: the TUI's `duration` memo (`index.tsx:2253-2258`) needs a `role === "assistant"` message with `time.completed` and will keep reporting `0`. The completed line will read "N tool calls" with a wrong duration. This is why `activityLine` (our own `_Subagent ran N steps in Xs._` message) is retained.

## File Structure

- **Create** `src/provider/cursor-transcript.ts` — locating and tailing Cursor's subagent JSONL. Pure filesystem + parsing; no opencode types.
- **Create** `src/provider/child-parts.ts` — part-id generation and the `updatePart` upsert. Pure opencode-side; no Cursor types.
- **Modify** `src/provider/subagent-bridge.ts` — `SubagentLiveSession` gains `messageID` + `toolPart()`; fix live stamping.
- **Modify** `src/provider/stream-map.ts` — start the tail on task tool-call, stop it on tool-result.
- **Test** `test/cursor-transcript.test.ts`, `test/child-parts.test.ts`, plus additions to `test/subagent-bridge.test.ts`.

Keeping Cursor-side and opencode-side concerns in separate files matters here: they have independent failure modes and each is testable without the other.

---

### Task 1: Diagnose the live stamp and confirm transcript liveness

**Blocking.** Everything else depends on `state.metadata.sessionId` being set while the task part is `running` (otherwise `sessionID()` is undefined, `messages()` is empty, and no subtitle can render regardless of what we write). Diagnostics for this already shipped in `subagent-bridge.ts` (`skipStamp`, "stamped task part", "task part stamp failed").

**Files:**

- Read: `~/.local/share/opencode/log/opencode.log`
- Modify: `src/provider/subagent-bridge.ts` (fix depends on finding)

- [ ] **Step 1: Restart opencode in this worktree and run one Cursor subagent task**

The running process must postdate the build. Confirm:

```bash
for pid in $(pgrep -x opencode); do
  cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | grep '^n' | cut -c2-)
  case "$cwd" in *subagent-output-into-subagent-view*) ps -o pid,lstart= -p "$pid";; esac
done
stat -f '%Sm %N' dist/provider/index.js
```

Expected: process start time is later than the dist mtime.

- [ ] **Step 2: Read the stamp diagnostics**

```bash
grep -E "subagent: task part stamp" ~/.local/share/opencode/log/opencode.log | tail -20
```

Expected: exactly one of —

- `stamp skipped {reason: "event state pending"}` → the hook sees only `pending`; fix by accepting `pending` as stampable (a pending part is still pre-completion) and re-reading before PATCH.
- `stamp skipped {reason: "no bridge"}` → `setSubagentBridge` is not called on this path; wire it.
- `stamp failed {error: …}` → the PATCH is rejected; fix the payload per `handlers/session.ts:397-411`.
- No lines at all → the `event` hook never fires for this part; verify the plugin is loaded and `part.callID` matches the registered id by logging both.

- [ ] **Step 3: Confirm the transcript grows during the run**

While a subagent task is running, in a second shell:

```bash
BASE=~/.cursor/projects/<project-slug>/agent-transcripts
watch -n1 'find '"$BASE"' -path "*/subagents/*.jsonl" -newermt "-2 minutes" -exec wc -l {} \;'
```

Expected: line count increases while the subagent is still running.

The write path is already proven (see Evidence); this measures **cadence**. If the file only reaches its final size at completion, the subtitle will appear late rather than never — report the observed cadence before continuing to Task 6.

- [ ] **Step 4: Apply the stamp fix indicated by Step 2, then verify**

Re-run a task; the card must be `ctrl+x down` navigable *before* the subagent finishes.

- [ ] **Step 5: Commit**

```bash
git add src/provider/subagent-bridge.ts
git commit -m "fix: stamp child session id on the running task part"
```

---

### Task 2: Part id generation and tool-part upsert

**Files:**

- Create: `src/provider/child-parts.ts`
- Test: `test/child-parts.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `createPartID(now?: number): string`
  - `upsertToolPart(opts: { sessionID: string; messageID: string; partID: string; callID: string; tool: string; status: "running" | "completed"; title?: string; input?: unknown; output?: string; start: number; end?: number }): Promise<boolean>` — resolves `true` on a successful PATCH, `false` otherwise. Never throws.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { createPartID } from "../src/provider/child-parts.js";

describe("createPartID", () => {
  it("matches opencode's ascending part id format", () => {
    // packages/opencode/src/id/id.ts:51 — prefix + "_" + 6 hex bytes + 14 base62
    expect(createPartID()).toMatch(/^prt_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  });

  it("is monotonic within the same millisecond", () => {
    const ids = Array.from({ length: 50 }, () => createPartID(1786052248042));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(50);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/child-parts.test.ts`
Expected: FAIL — cannot resolve `../src/provider/child-parts.js`.

- [ ] **Step 3: Implement `createPartID`**

```typescript
import { randomBytes } from "node:crypto";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const RANDOM_LENGTH = 14;

let lastTimestamp = 0;
let counter = 0;

/**
 * Generate an opencode-compatible ascending part id. Mirrors
 * `packages/opencode/src/id/id.ts:51` — a 6-byte big-endian
 * `timestamp * 0x1000 + counter` in hex, then random base62. The counter keeps
 * ids monotonic (and unique) within a millisecond, which is what makes parts
 * sort correctly in the TUI.
 */
export function createPartID(now?: number): string {
  const timestamp = now ?? Date.now();
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp;
    counter = 0;
  }
  counter++;
  const value = BigInt(timestamp) * BigInt(0x1000) + BigInt(counter);
  const bytes = Buffer.alloc(6);
  for (let i = 0; i < 6; i++) {
    bytes[i] = Number((value >> BigInt(40 - 8 * i)) & BigInt(0xff));
  }
  let random = "";
  const raw = randomBytes(RANDOM_LENGTH);
  for (let i = 0; i < RANDOM_LENGTH; i++) random += BASE62[raw[i]! % 62];
  return `prt_${bytes.toString("hex")}${random}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/child-parts.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the failing test for `upsertToolPart`**

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearSubagentBridge, setSubagentBridge } from "../src/provider/subagent-bridge.js";
import { createPartID, upsertToolPart } from "../src/provider/child-parts.js";

afterEach(() => clearSubagentBridge());

function fakeBridge() {
  const calls: any[] = [];
  const request = vi.fn(async (opts: any) => { calls.push(opts); return {}; });
  setSubagentBridge({ client: { _client: { request } } as any, directory: "/w" });
  return { calls };
}

describe("upsertToolPart", () => {
  it("PATCHes a running tool part with a title", async () => {
    const { calls } = fakeBridge();
    const ok = await upsertToolPart({
      sessionID: "ses_c", messageID: "msg_1", partID: createPartID(),
      callID: "c1", tool: "read", status: "running",
      title: "CHANGELOG.md", input: { path: "CHANGELOG.md" }, start: 5,
    });
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].url).toBe("/session/{sessionID}/message/{messageID}/part/{partID}");
    expect(calls[0].body.type).toBe("tool");
    expect(calls[0].body.tool).toBe("read");
    expect(calls[0].body.state).toMatchObject({
      status: "running", title: "CHANGELOG.md", time: { start: 5 },
    });
  });

  it("sends the path params the endpoint validates against the body", async () => {
    const { calls } = fakeBridge();
    const partID = createPartID();
    await upsertToolPart({
      sessionID: "ses_c", messageID: "msg_1", partID, callID: "c1",
      tool: "bash", status: "completed", title: "git status",
      output: "clean", start: 1, end: 2,
    });
    // handlers/session.ts:403-409 rejects the request unless these match.
    expect(calls[0].path).toEqual({ sessionID: "ses_c", messageID: "msg_1", partID });
    expect(calls[0].body.id).toBe(partID);
    expect(calls[0].body.messageID).toBe("msg_1");
    expect(calls[0].body.sessionID).toBe("ses_c");
    expect(calls[0].body.state.status).toBe("completed");
    expect(calls[0].body.state.output).toBe("clean");
  });

  it("returns false and never throws when the request fails", async () => {
    const request = vi.fn(async () => { throw new Error("boom"); });
    setSubagentBridge({ client: { _client: { request } } as any });
    const ok = await upsertToolPart({
      sessionID: "s", messageID: "m", partID: createPartID(),
      callID: "c", tool: "read", status: "running", start: 0,
    });
    expect(ok).toBe(false);
  });

  it("returns false when no bridge is published", async () => {
    const ok = await upsertToolPart({
      sessionID: "s", messageID: "m", partID: createPartID(),
      callID: "c", tool: "read", status: "running", start: 0,
    });
    expect(ok).toBe(false);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run test/child-parts.test.ts`
Expected: FAIL — `upsertToolPart` is not exported.

- [ ] **Step 7: Implement `upsertToolPart`**

```typescript
import { getSubagentBridge } from "./subagent-bridge.js";
import { pluginLog } from "./log-bridge.js";

const PART_URL = "/session/{sessionID}/message/{messageID}/part/{partID}";

/**
 * Create or update a `tool` part in a child session. `updatePart` is an upsert
 * (`processor.ts:242` creates parts through it), so a fresh `partID` inserts.
 * The TUI's subagent card reads exactly these parts to render its activity
 * subtitle (`routes/session/index.tsx:2227-2279`).
 *
 * Best-effort: never throws, but always logs — a silent failure here is
 * indistinguishable from "the subagent did nothing".
 */
export async function upsertToolPart(opts: {
  sessionID: string;
  messageID: string;
  partID: string;
  callID: string;
  tool: string;
  status: "running" | "completed";
  title?: string;
  input?: unknown;
  output?: string;
  start: number;
  end?: number;
}): Promise<boolean> {
  const bridge = getSubagentBridge();
  const request = (bridge?.client as unknown as {
    _client?: { request?: (o: Record<string, unknown>) => Promise<unknown> };
  } | undefined)?._client?.request;
  if (!bridge || !request) {
    pluginLog("debug", "subagent: tool part skipped", { reason: "no bridge", tool: opts.tool });
    return false;
  }
  const state: Record<string, unknown> = {
    status: opts.status,
    input: opts.input ?? {},
    time: opts.status === "completed" ? { start: opts.start, end: opts.end ?? Date.now() } : { start: opts.start },
  };
  if (opts.title) state["title"] = opts.title;
  if (opts.status === "completed") state["output"] = opts.output ?? "";
  try {
    await request({
      method: "PATCH",
      url: PART_URL,
      path: { sessionID: opts.sessionID, messageID: opts.messageID, partID: opts.partID },
      ...(bridge.directory ? { query: { directory: bridge.directory } } : {}),
      body: {
        id: opts.partID,
        messageID: opts.messageID,
        sessionID: opts.sessionID,
        type: "tool",
        callID: opts.callID,
        tool: opts.tool,
        state,
      },
    });
    return true;
  } catch (err) {
    pluginLog("warn", "subagent: tool part upsert failed", {
      tool: opts.tool,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run test/child-parts.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 9: Commit**

```bash
git add src/provider/child-parts.ts test/child-parts.test.ts
git commit -m "feat: upsert tool parts into subagent child sessions"
```

---

### Task 3: Parse Cursor subagent transcript lines

**Files:**

- Create: `src/provider/cursor-transcript.ts`
- Test: `test/cursor-transcript.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `type TranscriptEntry = { kind: "text"; role: string; text: string } | { kind: "tool"; role: string; name: string; input: unknown }`
  - `parseTranscriptLine(line: string): TranscriptEntry[]` — `[]` for blank/unparseable lines.
  - `toolTitle(input: unknown): string | undefined` — a short human label from a tool input.

- [ ] **Step 1: Write the failing test**

Shapes copied verbatim from the real 16:37 run
(`agent-b6786a00-…/subagents/edf3c300-….jsonl`).

```typescript
import { describe, expect, it } from "vitest";
import { parseTranscriptLine, toolTitle } from "../src/provider/cursor-transcript.js";

describe("parseTranscriptLine", () => {
  it("extracts assistant text", () => {
    const line = JSON.stringify({
      role: "assistant",
      message: { content: [{ type: "text", text: "Using navigating-codebases." }] },
    });
    expect(parseTranscriptLine(line)).toEqual([
      { kind: "text", role: "assistant", text: "Using navigating-codebases." },
    ]);
  });

  it("extracts multiple tool_use blocks from one line in order", () => {
    const line = JSON.stringify({
      role: "assistant",
      message: {
        content: [
          { type: "text", text: "working" },
          { type: "tool_use", name: "GetMcpTools", input: { server: "context-mode" } },
          { type: "tool_use", name: "Read", input: { path: "/tmp/SKILL.md", limit: 40 } },
        ],
      },
    });
    const out = parseTranscriptLine(line);
    expect(out).toHaveLength(3);
    expect(out[1]).toEqual({ kind: "tool", role: "assistant", name: "GetMcpTools", input: { server: "context-mode" } });
    expect(out[2]).toMatchObject({ kind: "tool", name: "Read" });
  });

  it("returns [] for blank or malformed lines", () => {
    expect(parseTranscriptLine("")).toEqual([]);
    expect(parseTranscriptLine("   ")).toEqual([]);
    expect(parseTranscriptLine("{not json")).toEqual([]);
    expect(parseTranscriptLine(JSON.stringify({ role: "user" }))).toEqual([]);
  });
});

describe("toolTitle", () => {
  it("prefers a path", () => {
    expect(toolTitle({ path: "/a/b/CHANGELOG.md", limit: 40 })).toBe("/a/b/CHANGELOG.md");
  });

  it("falls back through command, pattern, query, then server", () => {
    expect(toolTitle({ command: "git status" })).toBe("git status");
    expect(toolTitle({ pattern: "TODO" })).toBe("TODO");
    expect(toolTitle({ query: "how does x work" })).toBe("how does x work");
    expect(toolTitle({ server: "context-mode", toolName: "ctx_execute" })).toBe("context-mode");
  });

  it("returns undefined when nothing is recognisable", () => {
    expect(toolTitle({})).toBeUndefined();
    expect(toolTitle(undefined)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cursor-transcript.test.ts`
Expected: FAIL — cannot resolve `../src/provider/cursor-transcript.js`.

- [ ] **Step 3: Implement the parser**

```typescript
/** One renderable item from a Cursor subagent transcript line. */
export type TranscriptEntry =
  | { kind: "text"; role: string; text: string }
  | { kind: "tool"; role: string; name: string; input: unknown };

/** Keys a Cursor tool input may carry, best-title-first. */
const TITLE_KEYS = ["path", "command", "pattern", "query", "server"] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Parse one line of Cursor's subagent transcript JSONL. The SDK writes
 * `{role, message: {content: [...]}}` per turn (`357.js`, TranscriptStore),
 * where a block is `{type:"text", text}` or `{type:"tool_use", name, input}`.
 * Unparseable lines yield `[]` — the file is appended to while we read it, so
 * a torn final line is expected and must never throw.
 */
export function parseTranscriptLine(line: string): TranscriptEntry[] {
  if (!line.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];
  const role = typeof parsed["role"] === "string" ? parsed["role"] : "assistant";
  const message = parsed["message"];
  const content = isRecord(message) ? message["content"] : undefined;
  if (!Array.isArray(content)) return [];
  const out: TranscriptEntry[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block["type"] === "text" && typeof block["text"] === "string" && block["text"]) {
      out.push({ kind: "text", role, text: block["text"] });
    } else if (block["type"] === "tool_use" && typeof block["name"] === "string") {
      out.push({ kind: "tool", role, name: block["name"], input: block["input"] });
    }
  }
  return out;
}

/** Derive a short label for a tool call, mirroring opencode's `state.title`. */
export function toolTitle(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  for (const key of TITLE_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/cursor-transcript.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/provider/cursor-transcript.ts test/cursor-transcript.test.ts
git commit -m "feat: parse cursor subagent transcript lines"
```

---

### Task 4: Locate and tail the subagent transcript

**Files:**

- Modify: `src/provider/cursor-transcript.ts`
- Test: `test/cursor-transcript.test.ts`

**Interfaces:**

- Consumes: `parseTranscriptLine` (Task 3).
- Produces:
  - `cursorProjectDir(cwd: string, home?: string): string`
  - `findSubagentTranscript(opts: { projectDir: string; prompt: string; known: Set<string> }): Promise<string | undefined>`
  - `tailTranscript(opts: { file: string; onEntry: (e: TranscriptEntry) => void; signal: { stopped: boolean }; intervalMs?: number }): Promise<void>`

Correlation is by **prompt match**, not by filename: Cursor names files by subagent uuid, and concurrent subagents would otherwise be indistinguishable. Line 0 of each transcript embeds the task prompt inside `<user_query>`.

- [ ] **Step 1: Write the failing test**

```typescript
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cursorProjectDir, findSubagentTranscript, tailTranscript } from "../src/provider/cursor-transcript.js";

describe("cursorProjectDir", () => {
  it("slugs the cwd the way Cursor does", () => {
    // Observed: /Users/you/orca/ws -> Users-you-orca-ws
    expect(cursorProjectDir("/Users/j/orca/ws", "/Users/j")).toBe(
      "/Users/j/.cursor/projects/Users-j-orca-ws",
    );
  });
});

function seed() {
  const root = mkdtempSync(join(tmpdir(), "cursor-tx-"));
  const subs = join(root, "agent-transcripts", "agent-a", "subagents");
  mkdirSync(subs, { recursive: true });
  return { root, subs };
}

describe("findSubagentTranscript", () => {
  it("finds the file whose first line contains the prompt", async () => {
    const { root, subs } = seed();
    writeFileSync(join(subs, "other.jsonl"), JSON.stringify({
      role: "user", message: { content: [{ type: "text", text: "<user_query>something else</user_query>" }] },
    }) + "\n");
    writeFileSync(join(subs, "mine.jsonl"), JSON.stringify({
      role: "user", message: { content: [{ type: "text", text: "<user_query>Read the CHANGELOG</user_query>" }] },
    }) + "\n");
    const found = await findSubagentTranscript({
      projectDir: root, prompt: "Read the CHANGELOG", known: new Set(),
    });
    expect(found).toBe(join(subs, "mine.jsonl"));
  });

  it("ignores files that existed before the task started", async () => {
    const { root, subs } = seed();
    const stale = join(subs, "stale.jsonl");
    writeFileSync(stale, JSON.stringify({
      role: "user", message: { content: [{ type: "text", text: "<user_query>Read the CHANGELOG</user_query>" }] },
    }) + "\n");
    const found = await findSubagentTranscript({
      projectDir: root, prompt: "Read the CHANGELOG", known: new Set([stale]),
    });
    expect(found).toBeUndefined();
  });

  it("returns undefined when the directory does not exist", async () => {
    const found = await findSubagentTranscript({
      projectDir: "/nope/nowhere", prompt: "x", known: new Set(),
    });
    expect(found).toBeUndefined();
  });
});

describe("tailTranscript", () => {
  it("emits entries appended after it starts, then stops on signal", async () => {
    const { subs } = seed();
    const file = join(subs, "live.jsonl");
    writeFileSync(file, "");
    const seen: string[] = [];
    const signal = { stopped: false };
    const done = tailTranscript({
      file,
      intervalMs: 10,
      signal,
      onEntry: (e) => { if (e.kind === "tool") seen.push(e.name); },
    });
    appendFileSync(file, JSON.stringify({
      role: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { path: "a" } }] },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 60));
    appendFileSync(file, JSON.stringify({
      role: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 60));
    signal.stopped = true;
    await done;
    expect(seen).toEqual(["Read", "Bash"]);
  });

  it("does not re-emit entries it already saw", async () => {
    const { subs } = seed();
    const file = join(subs, "once.jsonl");
    writeFileSync(file, JSON.stringify({
      role: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: {} }] },
    }) + "\n");
    const seen: string[] = [];
    const signal = { stopped: false };
    const done = tailTranscript({ file, intervalMs: 10, signal, onEntry: (e) => seen.push(e.kind) });
    await new Promise((r) => setTimeout(r, 60));
    signal.stopped = true;
    await done;
    expect(seen).toEqual(["tool"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cursor-transcript.test.ts`
Expected: FAIL — `cursorProjectDir` is not exported.

- [ ] **Step 3: Implement locating and tailing**

```typescript
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const POLL_INTERVAL_MS = 400;

/**
 * Cursor's per-project state directory. The slug is the absolute cwd with the
 * leading separator dropped and the rest replaced by `-` (observed:
 * `/Users/you/orca/…` -> `Users-you-orca-…`).
 */
export function cursorProjectDir(cwd: string, home = homedir()): string {
  const slug = cwd.replace(/^\/+/, "").replace(/\//g, "-");
  return join(home, ".cursor", "projects", slug);
}

async function subagentFiles(projectDir: string): Promise<string[]> {
  const root = join(projectDir, "agent-transcripts");
  const out: string[] = [];
  let agents: string[];
  try {
    agents = await readdir(root);
  } catch {
    return out;
  }
  for (const agent of agents) {
    const dir = join(root, agent, "subagents");
    try {
      for (const file of await readdir(dir)) {
        if (file.endsWith(".jsonl")) out.push(join(dir, file));
      }
    } catch {
      // Not every agent has subagents.
    }
  }
  return out;
}

/**
 * Find the transcript for a specific task by matching the prompt embedded in
 * the transcript's first line (`<user_query>…`). Filenames are subagent uuids,
 * so with concurrent subagents the prompt is the only reliable correlator.
 * `known` holds files that existed when the task started; they are skipped so
 * a previous run's transcript is never adopted.
 */
export async function findSubagentTranscript(opts: {
  projectDir: string;
  prompt: string;
  known: Set<string>;
}): Promise<string | undefined> {
  const needle = opts.prompt.trim().slice(0, 200);
  if (!needle) return undefined;
  for (const file of await subagentFiles(opts.projectDir)) {
    if (opts.known.has(file)) continue;
    try {
      const head = (await readFile(file, "utf8")).split("\n", 1)[0] ?? "";
      if (head.includes(needle)) return file;
    } catch {
      // Being written right now; try again on the next poll.
    }
  }
  return undefined;
}

/** Snapshot the transcripts that already exist, to skip them later. */
export async function knownTranscripts(projectDir: string): Promise<Set<string>> {
  return new Set(await subagentFiles(projectDir));
}

/**
 * Poll a transcript for new content until `signal.stopped`.
 *
 * Cursor rewrites this file in full on every checkpoint (it constructs the
 * store without `appendFile`, so `writeFromStateIncremental` always falls back
 * to `writeFromStateFull`). Progress is therefore tracked by the number of
 * COMPLETE lines already emitted, never by byte offset: a rewrite can make the
 * file momentarily shorter, which would stall an offset-based reader forever.
 *
 * A trailing fragment without a newline is a half-written final line and is
 * not counted, so it is re-read once complete.
 */
export async function tailTranscript(opts: {
  file: string;
  onEntry: (entry: TranscriptEntry) => void;
  signal: { stopped: boolean };
  intervalMs?: number;
}): Promise<void> {
  const interval = opts.intervalMs ?? POLL_INTERVAL_MS;
  let emitted = 0;
  while (!opts.signal.stopped) {
    try {
      const text = await readFile(opts.file, "utf8");
      const lines = text.split("\n");
      // A trailing "" means the text ended with a newline, so every remaining
      // element is a complete line; otherwise the last element is a fragment.
      const complete = lines[lines.length - 1] === "" ? lines.length - 1 : lines.length - 1;
      for (let i = emitted; i < complete; i++) {
        for (const entry of parseTranscriptLine(lines[i] ?? "")) opts.onEntry(entry);
      }
      if (complete > emitted) emitted = complete;
    } catch {
      // File may not exist yet or be mid-rewrite; retry next tick.
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/cursor-transcript.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add src/provider/cursor-transcript.ts test/cursor-transcript.test.ts
git commit -m "feat: locate and tail cursor subagent transcripts"
```

---

### Task 5: Expose the child message id and a tool-part writer

`upsertToolPart` needs a `messageID` in the child session. `linkSubagentSessionLive` currently discards the prompt response.

**Files:**

- Modify: `src/provider/subagent-bridge.ts:527-586`
- Test: `test/subagent-bridge.test.ts`

**Interfaces:**

- Consumes: `upsertToolPart`, `createPartID` (Task 2).
- Produces: `SubagentLiveSession` gains
  - `messageID: string | undefined`
  - `toolPart(opts: { callID: string; tool: string; title?: string; input?: unknown; status: "running" | "completed"; partID?: string; start: number }): Promise<string | undefined>` — returns the part id used, so the caller can flip the same part to `completed`.

- [ ] **Step 1: Write the failing test**

```typescript
it("captures the seeded message id and writes tool parts", async () => {
  const request = vi.fn(async () => ({}));
  const prompt = vi.fn(async () => ({ data: { info: { id: "msg_seed" } } }));
  const create = vi.fn(async () => ({ data: { id: "ses_child" } }));
  setSubagentBridge({
    client: { session: { create, prompt }, _client: { request } } as any,
    directory: "/w",
  });
  const live = await linkSubagentSessionLive({
    parentSessionID: "ses_parent",
    args: { description: "d", prompt: "do the thing" },
  });
  expect(live?.messageID).toBe("msg_seed");
  const partID = await live!.toolPart({
    callID: "c1", tool: "read", title: "a.ts", status: "running", start: 1,
  });
  expect(partID).toMatch(/^prt_/);
  expect(request).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/subagent-bridge.test.ts`
Expected: FAIL — `live.messageID` is `undefined`.

- [ ] **Step 3: Capture the message id and add `toolPart`**

Inspect the real `session.prompt` response before finalising the accessor — log `JSON.stringify(res?.data)` once and read the actual key (`data.info.id` is the expectation; correct the code if it differs). Then, inside `linkSubagentSessionLive`, replace the seeding block:

```typescript
    let messageID: string | undefined;
    const prompt = strField(opts.args, "prompt");
    if (prompt) {
      const seeded = await client.session.prompt({
        path: { id: childId },
        ...(query ? { query } : {}),
        body: { noReply: true, parts: [{ type: "text", text: prompt }] },
      });
      messageID = strField((seeded?.data as { info?: unknown } | undefined)?.info, "id");
    }
```

and extend the returned object:

```typescript
      messageID,
      toolPart: async (o) => {
        if (done || !messageID) return undefined;
        const partID = o.partID ?? createPartID();
        const ok = await upsertToolPart({
          sessionID: childId,
          messageID,
          partID,
          callID: o.callID,
          tool: o.tool,
          status: o.status,
          title: o.title,
          input: o.input,
          start: o.start,
        });
        return ok ? partID : undefined;
      },
```

Add `messageID` and `toolPart` to the `SubagentLiveSession` interface, and import `createPartID`/`upsertToolPart` from `./child-parts.js`.

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run`
Expected: PASS, no regressions.

- [ ] **Step 5: Commit**

```bash
git add src/provider/subagent-bridge.ts test/subagent-bridge.test.ts
git commit -m "feat: write tool parts into the subagent child session"
```

---

### Task 6: Wire the tail into the task lifecycle

**Files:**

- Modify: `src/provider/stream-map.ts:1240-1254` (start) and `:1320-1342` (stop)
- Test: `test/stream-map.test.ts`

**Interfaces:**

- Consumes: everything above.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

```typescript
it("stops tailing when the subagent task completes", async () => {
  // Drive cursorEventsToStream with a task tool-call then tool-result and
  // assert the tail signal is flipped, so no timer outlives the turn.
  // (Model on the existing subagent test at test/stream-map.test.ts:1740.)
});
```

Fill this in against the existing helper in that file — assert that after the `tool-result` event the registered tail signal has `stopped === true`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/stream-map.test.ts`
Expected: FAIL — the signal stays `false`.

- [ ] **Step 3: Start the tail alongside the existing live link**

Immediately after `registerSubagentCall(event.id, live.childId)`:

```typescript
         const signal = { stopped: false };
         subagentTails.set(event.id, signal);
         void startSubagentTail({
          live,
          signal,
          prompt: strField(event.input, "prompt") ?? "",
          cwd: ctx.directory ?? process.cwd(),
         });
```

Add a module-level `const subagentTails = new Map<string, { stopped: boolean }>()`, and a helper that snapshots existing transcripts, polls `findSubagentTranscript` until the file appears (giving up after ~30s), then `tailTranscript`s it — converting each `tool` entry into a `running` then `completed` tool part via `live.toolPart`, and ignoring `text` entries (the final answer already arrives through `finalize`).

- [ ] **Step 4: Stop the tail on both completion paths**

In the tool-result success and error branches, beside each `unregisterSubagentCall(event.id)`:

```typescript
         const tail = subagentTails.get(event.id);
         if (tail) {
          tail.stopped = true;
          subagentTails.delete(event.id);
         }
```

- [ ] **Step 5: Run the full suite**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck clean; all tests pass.

- [ ] **Step 6: Exercise it**

Rebuild, restart opencode in this worktree, run a Cursor subagent task, and watch the card. Expected: `↳ Read <path>` style subtitle updating while the subagent runs, and the card navigable throughout.

- [ ] **Step 7: Commit**

```bash
git add src/provider/stream-map.ts test/stream-map.test.ts
git commit -m "feat: stream cursor subagent activity into the task card"
```

---

## Self-Review Notes

- **Spec coverage:** navigation (Task 1), live subtitle (Tasks 2-6), transcript fidelity (already shipped, plus Task 3's parser).
- **Sequencing risk:** Task 1 gates everything. If its Step 3 shows the transcript is written only at completion, Tasks 3-6 must be abandoned rather than adapted.
- **Type consistency:** `toolPart` returns `string | undefined` in Tasks 5 and 6; `upsertToolPart` returns `boolean` in Task 2 — the adapter in Task 5 converts between them.
- **Cleanup:** every tail owns a `signal` that must be flipped on both the success and error result paths, or a polling timer outlives the turn.
