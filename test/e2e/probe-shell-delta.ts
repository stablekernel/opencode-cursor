// Probe: enumerate ALL update types; flag shell tool-calls + shell-output-delta. Run: bun test/e2e/probe-shell-delta.ts
import { Agent, Cursor } from "@cursor/sdk";
Cursor.configure({ local: { useHttp1ForAgent: true } });
const agent = await Agent.create({
	apiKey: process.env.CURSOR_API_KEY,
	model: { id: process.env.CURSOR_E2E_MODEL ?? "auto" },
	local: { cwd: process.cwd() },
});
const typeCounts: Record<string, number> = {};
let shellDeltaSamples = 0;
let shellToolCalls = 0;
const run = await agent.send(
	"Use your shell tool to run this exact command and show me the output: for i in 1 2 3 4 5; do echo line$i; sleep 1; done",
	{
		onDelta: ({ update }) => {
			typeCounts[update.type] = (typeCounts[update.type] ?? 0) + 1;
			if (update.type === "shell-output-delta") {
				if (shellDeltaSamples < 5) process.stdout.write(`DELTA ${JSON.stringify(update)}\n`);
				shellDeltaSamples++;
			}
			if (
				(update.type === "tool-call-started" || update.type === "tool-call-completed") &&
				(update as { toolCall?: { type?: string } }).toolCall?.type === "shell"
			) {
				shellToolCalls++;
				if (shellToolCalls <= 2)
					process.stdout.write(`SHELLTOOL ${update.type} ${JSON.stringify((update as { toolCall?: unknown }).toolCall).slice(0, 300)}\n`);
			}
		},
	},
);
await run.wait();
process.stdout.write(`\nTYPE_COUNTS ${JSON.stringify(typeCounts)}\n`);
process.stdout.write(`SHELL_TOOL_CALLS ${shellToolCalls}\n`);
process.stdout.write(`SHELL_OUTPUT_DELTAS ${shellDeltaSamples}\n`);
