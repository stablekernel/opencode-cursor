import { pluginLog } from "./log-bridge.js";

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

function stripAnsi(input: string): string {
	return input.replace(ANSI_PATTERN, "");
}

/**
 * `@cursor/sdk`'s bundled local-exec runtime formats its "rules"/"skills"
 * loading diagnostics (context logger `local-exec:cursor-rules`) into one
 * preformatted string and writes it straight to `console.log` — there is no
 * public logger hook to redirect it instead. Observed shapes (colors
 * stripped):
 *
 *   16:05:53.036 INFO  LocalCursorRulesService load completed meta={durationMs: 89, ruleCount: 1}
 *   16:05:53.036 INFO  AgentSkillsCursorRulesService load completed meta={durationMs: 86, ruleCount: 18, skillCount: 18}
 *   16:05:53.036 INFO  CursorPluginsAgentSkillsService load completed meta={durationMs: 12, ruleCount: 2, skillCount: 0}
 *
 * The context path (`ctx=...`) is only present in some builds/configs.
 */
const RULE_LOAD_PATTERN =
	/^\d{2}:\d{2}:\d{2}\.\d{3}\s+INFO\s+(LocalCursorRulesService|AgentSkillsCursorRulesService|CursorPluginsAgentSkillsService) load completed(?:\s+ctx=\S+)?\s+meta=\{([^}]*)\}\s*$/;

/** Parses the `meta={key: value, ...}` tail into a plain numeric object. */
export function parseCursorLogMeta(raw: string): Record<string, number> {
	const out: Record<string, number> = {};
	for (const part of raw.split(",")) {
		const [key, value] = part.split(":").map((s) => s.trim());
		if (!key || value === undefined) continue;
		const num = Number(value);
		if (Number.isFinite(num)) out[key] = num;
	}
	return out;
}

export interface ParsedCursorRuleLog {
	service: string;
	meta: Record<string, number>;
}

/** Matches one line against the known Cursor rules/skills load-completion shape. */
export function parseCursorRuleLoadLine(line: string): ParsedCursorRuleLog | undefined {
	const match = RULE_LOAD_PATTERN.exec(stripAnsi(line));
	if (!match) return undefined;
	const [, service, meta] = match;
	if (!service) return undefined;
	return { service, meta: parseCursorLogMeta(meta ?? "") };
}

let installed = false;
let original: typeof console.log | undefined;

/**
 * Installs a narrowly-scoped `console.log` interceptor that recognizes only
 * the known Cursor rules/skills "load completed" messages (see
 * {@link parseCursorRuleLoadLine}) and re-emits them as structured opencode
 * logs via {@link pluginLog}. Every other `console.log` call — including
 * anything else the SDK or the host process writes — passes through
 * unchanged.
 *
 * Only relevant to the in-process transport, where the SDK runs inside this
 * process and writes directly to the shared global `console`. The sidecar
 * transport intercepts the same messages in the child process instead (see
 * `src/sidecar/agent-host.mjs`) and forwards them over the JSONL protocol.
 *
 * Idempotent: safe to call on every agent creation.
 */
export function installCursorLogInterceptor(): void {
	if (installed) return;
	original = console.log.bind(console);
	const passthrough = original;
	console.log = (...args: unknown[]) => {
		if (args.length === 1 && typeof args[0] === "string") {
			const parsed = parseCursorRuleLoadLine(args[0]);
			if (parsed) {
				pluginLog("info", `${parsed.service} load completed`, parsed.meta);
				return;
			}
		}
		passthrough(...(args as Parameters<typeof console.log>));
	};
	installed = true;
}

/** Test hook. */
export function resetCursorLogInterceptor(): void {
	if (original) console.log = original;
	original = undefined;
	installed = false;
}
