/**
 * Client half of the Node sidecar (see src/sidecar/agent-host.mjs for the
 * protocol and the why). Spawns one Node child per client and multiplexes
 * agent create/resume/send/cancel/close requests over JSON-lines stdio,
 * exposing agents through the same minimal surface the provider already
 * consumes ({@link AgentLike}), so session-pool/agent-events need no
 * sidecar-specific logic.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";

/** Minimal run surface the provider consumes (subset of the SDK's Run). */
export interface AgentRunLike {
  wait(): Promise<{ status: string; result?: string }>;
  cancel(): void | Promise<void>;
}

export interface AgentSendOptions {
  mode?: string;
  onDelta?: (input: { update: Record<string, unknown> & { type: string } }) => void;
  local?: { force?: boolean };
}

/** Minimal agent surface the provider consumes (subset of the SDK's SDKAgent). */
export interface AgentLike {
  agentId: string;
  send(message: unknown, options?: AgentSendOptions): Promise<AgentRunLike>;
  close(): void;
}

export interface SidecarClientOptions {
  /** Path to the agent-host script. */
  scriptPath: string;
  /** Node executable; default "node" from PATH. */
  nodePath?: string;
  /** Extra environment for the child (merged over process.env). */
  env?: Record<string, string>;
  /** Mirror child stderr to this process (debug aid). */
  debug?: boolean;
}

interface Pending {
  resolve: (msg: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  /** Streaming hooks for "send" requests. */
  onUpdate?: (update: Record<string, unknown> & { type: string }) => void;
  onResult?: (result: { status: string; result?: string }) => void;
  onStreamError?: (err: Error) => void;
}

function reviveError(error: unknown): Error {
  const e = (error ?? {}) as { name?: string; message?: string };
  const err = new Error(e.message ?? "sidecar error");
  if (e.name) err.name = e.name;
  return err;
}

export class SidecarClient {
  private readonly options: SidecarClientOptions;
  private child: ChildProcessByStdio<Writable, Readable, Readable> | undefined;
  private reader: Interface | undefined;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private disposed = false;

  constructor(options: SidecarClientOptions) {
    this.options = options;
  }

  /** Spawn (or reuse) the child process. */
  private ensureChild(): ChildProcessByStdio<Writable, Readable, Readable> {
    if (this.disposed) throw new Error("cursor sidecar client disposed");
    if (this.child) return this.child;

    const child = spawn(this.options.nodePath ?? "node", [this.options.scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.options.env },
    });
    this.child = child;

    this.reader = createInterface({ input: child.stdout });
    this.reader.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk: Buffer) => {
      if (this.options.debug || process.env["OPENCODE_CURSOR_DEBUG"]) {
        process.stderr.write(`[cursor:sidecar] ${chunk}`);
      }
    });
    child.on("exit", (code) => {
      this.failAll(new Error(`cursor sidecar exited (code ${code ?? "unknown"})`));
      this.child = undefined;
      this.reader?.close();
      this.reader = undefined;
    });
    child.on("error", (err) => {
      this.failAll(new Error(`cursor sidecar failed to start: ${err.message}`));
      this.child = undefined;
    });
    this.updateRefs();
    return child;
  }

  /**
   * Keep the child (and its pipes) from holding the parent's event loop open
   * while idle, but ref it whenever a reply is outstanding so the loop can't
   * exit mid-request. Without this, any process that uses the provider and
   * never dispose()s — scripts, tests, opencode itself on shutdown — hangs.
   */
  private updateRefs(): void {
    const child = this.child;
    if (!child) return;
    const refable = [child, child.stdin, child.stdout, child.stderr] as Array<{
      ref?: () => void;
      unref?: () => void;
    }>;
    if (this.pending.size > 0) {
      for (const target of refable) target.ref?.();
    } else {
      for (const target of refable) target.unref?.();
    }
  }

  private failAll(err: Error): void {
    for (const pending of this.pending.values()) {
      pending.onStreamError?.(err);
      pending.reject(err);
    }
    this.pending.clear();
    this.updateRefs();
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // ignore non-protocol noise on stdout
    }
    const id = msg["id"];
    if (typeof id !== "number") return;
    const pending = this.pending.get(id);
    if (!pending) return;

    const ev = msg["ev"];
    if (ev === "update") {
      pending.onUpdate?.(msg["update"] as Record<string, unknown> & { type: string });
      return;
    }
    if (ev === "result") {
      this.pending.delete(id);
      this.updateRefs();
      pending.onResult?.(msg["result"] as { status: string; result?: string });
      return;
    }
    if (ev === "error") {
      this.pending.delete(id);
      this.updateRefs();
      pending.onStreamError?.(reviveError(msg["error"]));
      return;
    }

    if (msg["ok"] === true) {
      // "send" acks stay pending for their streaming terminal event.
      if (!pending.onResult) {
        this.pending.delete(id);
        this.updateRefs();
      }
      pending.resolve(msg);
    } else {
      this.pending.delete(id);
      this.updateRefs();
      pending.reject(reviveError(msg["error"]));
    }
  }

  private request(
    payload: Record<string, unknown>,
    hooks?: Pick<Pending, "onUpdate" | "onResult" | "onStreamError">,
  ): Promise<Record<string, unknown>> {
    const child = this.ensureChild();
    const id = this.nextId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, ...hooks });
      this.updateRefs();
      child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`, (err) => {
        if (err) {
          this.pending.delete(id);
          this.updateRefs();
          reject(err);
        }
      });
    });
  }

  async createAgent(options: unknown): Promise<AgentLike> {
    const res = await this.request({ op: "create", options });
    return this.wrapAgent(String(res["agentId"]));
  }

  async resumeAgent(agentId: string, options: unknown): Promise<AgentLike> {
    const res = await this.request({ op: "resume", agentId, options });
    return this.wrapAgent(String(res["agentId"]));
  }

  private wrapAgent(agentId: string): AgentLike {
    return {
      agentId,
      send: (message, options) => this.sendTurn(agentId, message, options),
      close: () => {
        void this.request({ op: "close", agentId }).catch(() => {
          // best effort, mirrors SDKAgent.close()
        });
      },
    };
  }

  private async sendTurn(
    agentId: string,
    message: unknown,
    options?: AgentSendOptions,
  ): Promise<AgentRunLike> {
    let settle!: {
      resolve: (r: { status: string; result?: string }) => void;
      reject: (e: Error) => void;
    };
    const waited = new Promise<{ status: string; result?: string }>((resolve, reject) => {
      settle = { resolve, reject };
    });
    // Avoid unhandled-rejection noise when the consumer never calls wait().
    waited.catch(() => {});

    let sendId: number | undefined;
    const ack = this.request(
      {
        op: "send",
        agentId,
        message,
        ...(options?.mode ? { mode: options.mode } : {}),
        ...(options?.local?.force ? { force: true } : {}),
      },
      {
        onUpdate: (update) => options?.onDelta?.({ update }),
        onResult: (result) => settle.resolve(result),
        onStreamError: (err) => settle.reject(err),
      },
    );
    // The request id is allocated synchronously inside request(); capture it
    // for cancel by reading the id we just used.
    sendId = this.nextId - 1;

    await ack;
    return {
      wait: () => waited,
      cancel: async () => {
        if (sendId === undefined) return;
        await this.request({ op: "cancel", sendId }).catch(() => {});
      },
    };
  }

  /** Kill the child and reject anything in flight. */
  dispose(): void {
    this.disposed = true;
    this.failAll(new Error("cursor sidecar client disposed"));
    this.reader?.close();
    this.reader = undefined;
    this.child?.kill();
    this.child = undefined;
  }
}
