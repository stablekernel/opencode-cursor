/**
 * Classify errors from the Cursor SDK into recovery actions. Works off plain
 * {name, message, status?, code?, isRetryable?, helpUrl?} shape ONLY — errors
 * that cross the Node sidecar arrive as re-hydrated plain Errors (never SDK
 * instances), so `instanceof` discrimination is impossible on the Bun side and
 * forbidden here.
 */
export type CursorErrorKind =
	| "agent-not-found"
	| "agent-busy"
	| "rate-limit"
	| "network"
	| "auth"
	| "config"
	| "unknown";

export interface ClassifiedError {
	kind: CursorErrorKind;
	/** Safe to retry the same operation (bounded by the caller). */
	retryable: boolean;
	status?: number;
	helpUrl?: string;
	message: string;
}

export function classifyError(err: unknown): ClassifiedError {
	const e = (err ?? {}) as {
		name?: string;
		message?: string;
		status?: unknown;
		code?: unknown;
		isRetryable?: unknown;
		helpUrl?: unknown;
	};
	const name = typeof e.name === "string" ? e.name : "Error";
	const message = typeof e.message === "string" ? e.message : String(err);
	const status = typeof e.status === "number" ? e.status : undefined;
	const code = typeof e.code === "string" ? e.code : undefined;
	const helpUrl = typeof e.helpUrl === "string" ? e.helpUrl : undefined;
	const base = { ...(status !== undefined ? { status } : {}), ...(helpUrl ? { helpUrl } : {}), message };

	switch (name) {
		case "AgentNotFoundError":
			return { kind: "agent-not-found", retryable: false, ...base };
		case "AgentBusyError":
			return { kind: "agent-busy", retryable: false, ...base };
		case "RateLimitError":
			return { kind: "rate-limit", retryable: true, ...base };
		case "NetworkError":
			return { kind: "network", retryable: true, ...base };
		case "AuthenticationError":
			return { kind: "auth", retryable: false, ...base };
		case "ConfigurationError":
		case "IntegrationNotConnectedError":
		case "UnsupportedRunOperationError":
			return { kind: "config", retryable: false, ...base };
	}

	// Transports/serializers that lose the class name but keep status/code.
	if (status === 401) return { kind: "auth", retryable: false, ...base };
	if (status === 429) return { kind: "rate-limit", retryable: true, ...base };
	if (status === 409) return { kind: "agent-busy", retryable: false, ...base };
	if (status === 503 || status === 504) return { kind: "network", retryable: true, ...base };
	if (code === "agent_not_found") return { kind: "agent-not-found", retryable: false, ...base };

	return { kind: "unknown", retryable: e.isRetryable === true, ...base };
}
