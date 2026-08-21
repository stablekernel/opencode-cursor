# Source findings: native-like Cursor subagent cards without an upstream PR

Research against the **installed** opencode source, v1.18.18 (sparse clone:
`/tmp/opencode-src`, sparse = packages/opencode/src, packages/tui/src,
packages/plugin/src, packages/sdk). The old checkout at
`~/workspace/opencode` is the 2025 Go-TUI architecture — **do not trust it**;
its task tool used `metadata.summary` and it has no PATCH part endpoint.

Also researched: `pi-cursor-sdk` + `@cursor/sdk`
(`~/.pi/agent/npm/node_modules/…`) for comparable patterns.

## Verified mechanism chain (v1.18.18)

1. **Native task tool stamps the link itself.** `tool/task.ts:167-176` creates
   the child session (`parentID: ctx.sessionID`), then `:185-193` calls
   `ctx.metadata({ title, metadata: { sessionId: nextSession.id, … } })`
   *before* executing. The link exists from the start of the run; there is no
   pending/running window to race.
2. **TUI card reads** `metadata.sessionId` (`tui/src/routes/session/index.tsx:2238`),
   syncs the child session on mount (`:2235-2238`), and renders the subtitle
   from `tool` parts in the child session: `tools()` memo `:2244-2248` (no role
   filter), `current()` `:2250-2252` (last part with status running/completed
   and a title), subtitle `:2279-2291` = `↳ <Tool> <title>`.
3. **PATCH part is an upsert.** `httpapi/handlers/session.ts:397-412` validates
   id/messageID/sessionID match the path and calls `session.updatePart`;
   `session.ts:637-646` publishes `SessionV1.Event.PartUpdated` → SSE
   `message.part.updated`. The TUI event handler (`tui/src/…/sync.tsx:165,376`)
   filters by **directory only** — child-session part updates reach the parent
   view live.
4. **`noReply` exists** (`session/prompt.ts:1504` schema, `:1069` skips the LLM
   loop) — a plugin can seed a message in a synthesized child session without
   invoking a model.
5. **Plugin surface** (`plugin/index.ts`): `event` hook fires for every
   directory event (`:257`); plugin gets a full SDK `client` (`:144,158-167`).

## Key improvement over the current plan: providerMetadata, not PATCH-stamping

`session/processor.ts:337-356` (tool-call) merges the AI SDK stream part's
`providerMetadata` into the tool part's top-level `metadata` — the exact field
the TUI card reads for `sessionId` (`:249` also sets metadata for
providerExecuted tools). Since this plugin **authors the stream**
(`stream-map.ts`), it can stamp `{ sessionId: childId }` as `providerMetadata`
on the task `tool-call` part inline. That:

- eliminates the Task-1 race entirely (no event-hook + re-read + PATCH),
- matches how the link is stored natively (same `metadata.sessionId` key),
- works while `pending`→`running` because the processor writes metadata on the
  tool-call event itself.

**Must verify empirically:** whether the processor stores `providerMetadata`
flat or namespaced by provider (`{ cursor: { sessionId } }` would not satisfy
`metadata.sessionId`). Read `processor.ts:337-356` closely and log one real
part. If namespaced, fall back to the plan's PATCH-stamp path.

## Cursor SDK side (pi-cursor-sdk comparison)

- Confirmed: `@cursor/sdk` `SendOptions` has only `onDelta`/`onStep`
  (`agent.d.ts:31-39`). No `onSubagent`, no nested stream events. Subagent
  activity lands only in the task result's `conversationSteps[]` +
  `transcriptPath` (both post-completion).
- pi-cursor-sdk does **no** live subagent streaming — it summarizes
  `conversationSteps` after completion
  (`cursor-tool-result-display-readers.ts:94-100`) and never reads
  `transcriptPath`. Our transcript-tail approach goes beyond it; no pattern to
  copy, but also no contradiction.
- Reusable detail: task args carry `subagentType: { kind, name }` — good for
  display naming of the card.

## Resulting architecture (addon-only, no upstream PR)

1. Child session created at task tool-call time (existing bridge code).
2. `sessionId` stamped via `providerMetadata` on the streamed tool-call part
   (new; replaces the racy PATCH stamp) — pending empirical check above.
3. Live activity: tail Cursor's on-disk subagent transcript (full-rewrite
   semantics, completed-line counting — as planned), upsert `tool` parts into
   the child session via the PATCH upsert endpoint. TUI receives the SSE part
   updates because filtering is by directory.
4. Final result still flows through the existing finalize path.

## Open verifications

- [ ] providerMetadata flat-vs-namespaced (see above) — decide stamp path.
- [ ] Transcript checkpoint cadence mid-run (plan Task 1 Step 3).
- [ ] noReply message shape: confirm which message id (user vs assistant) the
  response returns, for anchoring synthesized tool parts.
