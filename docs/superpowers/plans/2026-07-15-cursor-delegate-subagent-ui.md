# Cursor Delegate Subagent UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route `cursor_delegate` through a parent-linked opencode child session so Cursor activity appears live and remains navigable in the opencode subagent UI.

**Architecture:** Keep the existing auth and permission gate. Replace the direct `runDelegate` call with `client.session.create({ parentID })` and blocking `client.session.prompt(...)`. Use a short-lived child-session control map consumed by the existing `chat.params` hook to forward Cursor-only per-turn controls that the SDK prompt schema cannot carry directly.

**Tech Stack:** TypeScript, `@opencode-ai/plugin`, `@opencode-ai/sdk`, `@cursor/sdk`, Vitest, opencode V3 provider stream pipeline.

> **Status: Implemented.** All tasks below are complete. `cursor_delegate` routes through a parent-linked child session; per-turn `mode`/`thinking`/`sandbox`/`cwd`/`agentId` are forwarded via `chat.params`; the direct `runDelegate` runtime is removed; 298 tests, typecheck, and build pass. The unchecked step boxes are retained as the historical build record.

## Global Constraints

- `cursor_delegate` is the scoped feature; cloud delegation and Cursor internal subagents remain unchanged.
- Permission approval occurs before child-session creation or Cursor execution.
- Child sessions persist after completion.
- No private TUI APIs or synthetic event injection.
- No silent fallback to the old collapsed direct-SDK result.
- Preserve `prompt`, `model`, `mode`, `thinking`, `cwd`, `sandbox`, and `agentId` semantics.

---

### Task 1: Add Delegate Control Bridge

**Files:**
- Modify: `src/plugin/index.ts`
- Modify: `src/provider/language-model.ts:138-290`
- Modify: `test/plugin-tools.test.ts`
- Modify: `test/language-model.test.ts`

**Interfaces:**
- Produces `CursorDelegateControls` with `mode`, optional `thinking`, optional `sandbox`, and optional `agentId`.
- Produces plugin-local `Map<string, CursorDelegateControls>` registration and cleanup callbacks passed to `buildCursorTools`.
- Makes `chat.params` merge registered controls into `providerOptions.cursor` for the matching child session.

- [ ] **Step 1: Add failing plugin-hook tests**

Extend the existing `CursorPlugin chat.params hook` tests with a child-session control case:

```ts
it("applies registered delegate controls only to the matching child session", async () => {
  let childOptions: Record<string, unknown> | undefined;
  const client = fakeClient();
  const hooks = await plugin({ directory: "/work", client } as never);
  client.session.prompt.mockImplementation(async ({ path }: any) => {
    const output = { options: {} } as any;
    await hooks["chat.params"]!(
      { sessionID: path.id, agent: "build", model: { providerID: "cursor", modelID: "m" }, provider: {}, message: {} } as never,
      output,
    );
    childOptions = output.options;
    return { data: { info: {}, parts: [{ type: "text", text: "done" }] } } as any;
  });

  await hooks.tool!.cursor_delegate!.execute(
    { prompt: "p", model: "m", thinking: "high", sandbox: true, agentId: "cursor-agent" } as any,
    ctx(vi.fn().mockResolvedValue(undefined)),
  );

  expect(childOptions).toMatchObject({
    mode: "agent",
    thinking: "high",
    sandbox: true,
    agentId: "cursor-agent",
    sessionID: "child",
  });
});
```

Use the same registration path production code uses; do not introduce a test-only hook.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `npm test -- --run test/plugin-tools.test.ts`

Expected: FAIL because no delegate control registration path exists yet.

- [ ] **Step 3: Implement the control map**

In `src/plugin/index.ts`, add a plugin-local map and callbacks:

```ts
export interface CursorDelegateControls {
  mode: "agent" | "plan";
  thinking?: string;
  sandbox?: boolean;
  agentId?: string;
}

const delegateControls = new Map<string, CursorDelegateControls>();

const setDelegateControls = (sessionID: string, controls: CursorDelegateControls) => {
  delegateControls.set(sessionID, controls);
};

const clearDelegateControls = (sessionID: string) => {
  delegateControls.delete(sessionID);
};
```

In `chat.params`, after the existing plan-agent mapping, merge the matching entry:

```ts
const controls = delegateControls.get(input.sessionID);
if (controls) {
  output.options = {
    ...(output.options ?? {}),
    mode: controls.mode,
    ...(controls.thinking ? { thinking: controls.thinking } : {}),
    ...(controls.sandbox !== undefined ? { sandbox: controls.sandbox } : {}),
    ...(controls.agentId ? { agentId: controls.agentId } : {}),
  };
}
```

Pass `setDelegateControls` and `clearDelegateControls` into `buildCursorTools`. Keep controls session-scoped and remove them after the prompt settles.

- [ ] **Step 4: Add per-turn sandbox resolution**

In `src/provider/language-model.ts`, resolve sandbox from provider options before constructing `baseAcquire`:

```ts
const sandbox =
  typeof providerOptions?.["sandbox"] === "boolean"
    ? providerOptions["sandbox"]
    : this.config.sandbox;
```

Use `sandbox` in the existing acquire spread instead of `this.config.sandbox`. Keep all other acquire behavior unchanged.

- [ ] **Step 5: Add provider regression coverage**

Extend the existing language-model mock assertions to verify that `providerOptions.cursor.sandbox` is forwarded to `acquireAgent`, while an omitted per-turn value still uses the static provider setting. Keep existing explicit `agentId` coverage and add `thinking`/mode assertions only where the current test harness already observes `resolveControls` inputs.

- [ ] **Step 6: Run focused tests**

Run: `npm test -- --run test/plugin-tools.test.ts test/language-model.test.ts`

Expected: PASS.

---

### Task 2: Route `cursor_delegate` Through Child Session

**Files:**
- Modify: `src/plugin/cursor-tools.ts`
- Modify: `test/cursor-tools.test.ts`
- Modify: `src/plugin/index.ts` only if dependency wiring from Task 1 needs adjustment

**Interfaces:**
- `CursorToolDeps` consumes `client`, `setDelegateControls`, and `clearDelegateControls`.
- `cursor_delegate.execute` creates a child session using `context.sessionID` and prompts it with provider `cursor`.
- Successful result metadata contains `childSessionID`, `model`, and `status`.

- [ ] **Step 1: Replace direct-runtime mocks with child-session mocks**

Remove the `runDelegate` mock from `test/cursor-tools.test.ts`. Add a fake client factory:

```ts
function childClient() {
  return {
    session: {
      create: vi.fn().mockResolvedValue({ data: { id: "child-1" } }),
      prompt: vi.fn().mockResolvedValue({
        data: {
          info: {
            tokens: { input: 2, output: 3, reasoning: 1, cache: { read: 0, write: 0 } },
          },
          parts: [{ type: "text", text: "child result" }],
        },
      }),
      abort: vi.fn().mockResolvedValue({ data: {} }),
    },
  };
}
```

Update `withKey` and `noKey` dependencies to include the fake client and control callbacks.

- [ ] **Step 2: Add failing child-session behavior tests**

Cover permission denial, parent linking, directory/title, prompt model/parts/tool guard, control registration, returned text/metadata, prompt failure, and abort:

```ts
it("creates and prompts a parent-linked Cursor child session", async () => {
  const client = childClient();
  const setControls = vi.fn();
  const clearControls = vi.fn();
  const tools = buildCursorTools({
    resolveApiKey: () => "k",
    defaultCwd: () => "/work",
    client: client as any,
    setDelegateControls: setControls,
    clearDelegateControls: clearControls,
  });

  const out = await tools.cursor_delegate!.execute(
    { prompt: "inspect files", model: "composer-2.5", mode: "plan", thinking: "high" } as any,
    ctx(vi.fn().mockResolvedValue(undefined)),
  ) as any;

  expect(client.session.create).toHaveBeenCalledWith({
    body: expect.objectContaining({ parentID: "s", title: expect.stringContaining("inspect files") }),
    query: { directory: "/work" },
  });
  expect(client.session.prompt).toHaveBeenCalledWith({
    path: { id: "child-1" },
    query: { directory: "/work" },
    body: expect.objectContaining({
      model: { providerID: "cursor", modelID: "composer-2.5" },
      agent: "plan",
      parts: [{ type: "text", text: "inspect files" }],
      tools: { cursor_delegate: false },
    }),
  });
  expect(setControls).toHaveBeenCalledWith("child-1", {
    mode: "plan",
    thinking: "high",
  });
  expect(clearControls).toHaveBeenCalledWith("child-1");
  expect(out.output).toBe("child result");
  expect(out.metadata).toMatchObject({ childSessionID: "child-1", status: "finished" });
});
```

Add tests that denied permission makes zero SDK calls, prompt rejection returns `Delegation failed`, explicit `cwd` wins, and abort invokes `session.abort` for the child.

- [ ] **Step 3: Run focused tests and verify failure**

Run: `npm test -- --run test/cursor-tools.test.ts`

Expected: FAIL because `cursor_delegate` still calls `runDelegate`.

- [ ] **Step 4: Implement child-session orchestration**

In `src/plugin/cursor-tools.ts`:

1. Import `PluginInput` as a type and `PROVIDER_ID`.
2. Extend `CursorToolDeps` with the client and control callbacks.
3. Remove the `runDelegate` import and direct `DelegateResult` aggregation.
4. Add a bounded prompt-title helper that collapses whitespace and truncates the prompt preview.
5. Keep API-key resolution and `requestApproval` unchanged.
6. Create the child with:

```ts
const created = await deps.client.session.create({
  body: {
    parentID: context.sessionID,
    title: delegateTitle(args.prompt),
  },
  query: { directory },
});
```

7. Register controls before prompting:

```ts
deps.setDelegateControls(childID, {
  mode: args.mode ?? "agent",
  ...(args.thinking ? { thinking: args.thinking } : {}),
  ...(args.sandbox !== undefined ? { sandbox: args.sandbox } : {}),
  ...(args.agentId ? { agentId: args.agentId } : {}),
});
```

8. Prompt the child with `providerID: PROVIDER_ID`, the requested model, one text part, `agent: "plan"` only for plan mode, and `{ cursor_delegate: false }`.
9. Extract final output by concatenating returned parts whose type is `text`.
10. Return final text and metadata containing child session ID, model, and assistant token usage when available.
11. Register an abort listener that calls `client.session.abort({ path: { id: childID }, query: { directory } })`; remove it and clear controls in `finally`.
12. Convert create/prompt failures to `Delegation failed: ...` strings without masking cleanup failures.

- [ ] **Step 5: Run focused tests**

Run: `npm test -- --run test/cursor-tools.test.ts`

Expected: PASS.

---

### Task 3: Remove Obsolete Direct Delegate Runtime

**Files:**
- Delete: `src/provider/delegate.ts`
- Delete: `test/delegate.test.ts`
- Modify: `test/plugin-tools.test.ts`

**Interfaces:**
- No production code imports `runDelegate` after Task 2.
- Plugin integration tests use a fake opencode client and verify child-session delegation rather than mocking Cursor's direct delegate runtime.

- [ ] **Step 1: Update plugin integration tests**

Replace `runDelegate` mocks with a fake `input.client.session` implementation. Assert auth loader still supplies the key needed for the permission-gated tool and that the registered tool creates/prompts a child session.

- [ ] **Step 2: Run the integration test before deletion**

Run: `npm test -- --run test/plugin-tools.test.ts`

Expected: FAIL only where assertions still expect `runDelegate`; use failures to remove those stale assertions.

- [ ] **Step 3: Delete orphaned files and mocks**

Delete `src/provider/delegate.ts` and `test/delegate.test.ts`. Remove all `runDelegate` imports, mocks, and assertions. Do not alter `cloud-agent.ts` or its tests.

- [ ] **Step 4: Run all tests and typecheck**

Run: `npm test && npm run typecheck`

Expected: PASS with no `runDelegate` references in `src` or `test`.

---

### Task 4: Update User-Facing Delegation Documentation

**Files:**
- Modify: `README.md:107-112,251-264`
- Modify: `CHANGELOG.md` under the unreleased/current development entry if one exists; otherwise do not invent a release section

**Interfaces:**
- Documentation explains that `cursor_delegate` creates a persistent child session and that the child UI shows live Cursor activity.
- Argument table remains accurate: `agentId`, `sandbox`, `mode`, `thinking`, `cwd`, `prompt`, and `model` are supported.

- [ ] **Step 1: Update README delegation text**

Change the local tool description from “return its result” to “run the task in a parent-linked child session, stream activity into the opencode subagent UI, and return the final result.” Add one sentence that the child session remains available after completion.

- [ ] **Step 2: Add a focused changelog entry only if an existing unreleased section exists**

If `CHANGELOG.md` has no unreleased/development section, leave it unchanged. Do not add release metadata for this feature.

- [ ] **Step 3: Run final verification**

Run: `npm test && npm run typecheck && npm run build`

Expected: PASS. Inspect `git diff --check` and verify only the design, plan, implementation, tests, and directly related documentation changed.

## Verification Matrix

- Permission gate: denied calls create no child session.
- Parent linkage: child session has `parentID === context.sessionID`.
- Live rendering path: child uses provider `cursor`, so existing stream-map parts are persisted by opencode.
- Control forwarding: mode, thinking, sandbox, and explicit Cursor agent ID reach the provider only for the matching child session.
- Abort: child session abort endpoint is called once and listeners/maps are cleaned up.
- Persistence: no child deletion occurs after completion.
- Regression: cloud delegation and normal Cursor provider turns retain existing behavior.
