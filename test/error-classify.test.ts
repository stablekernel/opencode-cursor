import { describe, expect, it } from "vitest";
import { classifyError } from "../src/provider/error-classify.js";

function named(name: string, extra: Record<string, unknown> = {}): Error {
	const err = new Error(`${name} message`);
	err.name = name;
	return Object.assign(err, extra);
}

describe("classifyError", () => {
	it("classifies by error name (sidecar-revived shape)", () => {
		expect(classifyError(named("AgentNotFoundError")).kind).toBe("agent-not-found");
		expect(classifyError(named("AgentBusyError")).kind).toBe("agent-busy");
		expect(classifyError(named("RateLimitError")).kind).toBe("rate-limit");
		expect(classifyError(named("NetworkError")).kind).toBe("network");
		expect(classifyError(named("AuthenticationError")).kind).toBe("auth");
		expect(classifyError(named("ConfigurationError")).kind).toBe("config");
		expect(classifyError(named("IntegrationNotConnectedError")).kind).toBe("config");
		expect(classifyError(named("UnsupportedRunOperationError")).kind).toBe("config");
		expect(classifyError(named("SomeOtherError")).kind).toBe("unknown");
	});

	it("falls back to status/code heuristics when the name is lost", () => {
		expect(classifyError(named("Error", { status: 401 })).kind).toBe("auth");
		expect(classifyError(named("Error", { status: 429 })).kind).toBe("rate-limit");
		expect(classifyError(named("Error", { status: 409 })).kind).toBe("agent-busy");
		expect(classifyError(named("Error", { status: 503 })).kind).toBe("network");
		expect(classifyError(named("Error", { code: "agent_not_found" })).kind).toBe("agent-not-found");
	});

	it("marks rate-limit and network retryable, auth and config not", () => {
		expect(classifyError(named("RateLimitError")).retryable).toBe(true);
		expect(classifyError(named("NetworkError")).retryable).toBe(true);
		expect(classifyError(named("AuthenticationError")).retryable).toBe(false);
		expect(classifyError(named("ConfigurationError")).retryable).toBe(false);
		expect(classifyError(named("AgentNotFoundError")).retryable).toBe(false);
	});

	it("carries status and helpUrl through", () => {
		const c = classifyError(named("IntegrationNotConnectedError", { status: 400, helpUrl: "https://cursor.com/settings" }));
		expect(c.status).toBe(400);
		expect(c.helpUrl).toBe("https://cursor.com/settings");
	});

	it("handles non-Error throws", () => {
		expect(classifyError("boom").kind).toBe("unknown");
		expect(classifyError(undefined).kind).toBe("unknown");
	});
});
