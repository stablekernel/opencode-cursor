/** Resolve the cheapest live model for E2E: env override wins, else the first
 * catalog id matching a cheap tier, else "auto" (Cursor routes). */
export async function pickE2EModel(): Promise<string> {
	if (process.env.CURSOR_E2E_MODEL) return process.env.CURSOR_E2E_MODEL;
	try {
		const { Cursor } = await import("@cursor/sdk");
		const models = await Cursor.models.list({ apiKey: process.env.CURSOR_API_KEY });
		const cheap = models.find((m) => /haiku|mini|small|lite|nano/i.test(m.id));
		return (cheap ?? models[0])?.id ?? "auto";
	} catch {
		return "auto";
	}
}
