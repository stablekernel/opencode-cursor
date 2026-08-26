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

/**
 * One-shot `console.warn` diagnostics emitted at `@cursor/sdk` module load.
 * Currently exactly one known line (vendored tree-sitter natives missing,
 * shell parsing degrades to `parsingFailed`) — matched by prefix so future
 * SDK builds appending detail still get captured.
 */
const SDK_WARNING_PREFIXES = [
	"shell-parser: tree-sitter natives are unavailable in this artifact",
];

function matchesKnownSdkWarning(line: string): boolean {
	return SDK_WARNING_PREFIXES.some((prefix) => line.startsWith(prefix));
}

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
export function parseCursorRuleLoadLine(
	line: string,
): ParsedCursorRuleLog | undefined {
	const match = RULE_LOAD_PATTERN.exec(stripAnsi(line));
	if (!match) return undefined;
	const [, service, meta] = match;
	if (!service) return undefined;
	return { service, meta: parseCursorLogMeta(meta ?? "") };
}

let installed = false;
let originalLog: typeof console.log | undefined;
let originalWarn: typeof console.warn | undefined;

/**
 * Installs narrowly-scoped `console.log`/`console.warn` interceptors. On
 * `console.log`, recognizes only the known Cursor rules/skills "load
 * completed" messages (see {@link parseCursorRuleLoadLine}) and re-emits
 * them as structured opencode logs via {@link pluginLog}. On `console.warn`,
 * recognizes known one-shot SDK load diagnostics (see
 * {@link SDK_WARNING_PREFIXES}) and routes them the same way. Every other
 * `console.log`/`console.warn` call — including anything else the SDK or the
 * host process writes — passes through unchanged.
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
	originalLog = console.log.bind(console);
	const logPassthrough = originalLog;
	console.log = (...args: unknown[]) => {
		if (args.length === 1 && typeof args[0] === "string") {
			const parsed = parseCursorRuleLoadLine(args[0]);
			if (parsed) {
				pluginLog("info", `${parsed.service} load completed`, parsed.meta);
				return;
			}
		}
		logPassthrough(...(args as Parameters<typeof console.log>));
	};
	originalWarn = console.warn.bind(console);
	const warnPassthrough = originalWarn;
	console.warn = (...args: unknown[]) => {
		if (args.length === 1 && typeof args[0] === "string") {
			const line = stripAnsi(args[0]);
			if (matchesKnownSdkWarning(line)) {
				pluginLog("warn", line);
				return;
			}
		}
		warnPassthrough(...(args as Parameters<typeof console.warn>));
	};
	installed = true;
}

/** Test hook. */
export function resetCursorLogInterceptor(): void {
	if (originalLog) console.log = originalLog;
	if (originalWarn) console.warn = originalWarn;
	originalLog = undefined;
	originalWarn = undefined;
	installed = false;
}
