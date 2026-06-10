import { describe, expect, it } from "vitest";
import type { LanguageModelV3Prompt } from "@ai-sdk/provider";
import {
	latestUserMessage,
	promptToCursorMessage,
} from "../src/provider/message-map.js";

describe("promptToCursorMessage", () => {
	it("flattens a multi-role conversation into a transcript", () => {
		const prompt: LanguageModelV3Prompt = [
			{ role: "system", content: "Be concise." },
			{ role: "user", content: [{ type: "text", text: "Hello" }] },
			{ role: "assistant", content: [{ type: "text", text: "Hi there" }] },
			{ role: "user", content: [{ type: "text", text: "What is 2+2?" }] },
		];
		const msg = promptToCursorMessage(prompt);
		expect(msg.text).toContain("# System\nBe concise.");
		expect(msg.text).toContain("# User\nHello");
		expect(msg.text).toContain("# Assistant\nHi there");
		expect(msg.text).toContain("# User\nWhat is 2+2?");
		expect(msg.images).toBeUndefined();
	});

	it("attaches images from the final user turn as base64 data", () => {
		const bytes = new Uint8Array([1, 2, 3, 4]);
		const prompt: LanguageModelV3Prompt = [
			{
				role: "user",
				content: [
					{ type: "text", text: "Describe this" },
					{ type: "file", data: bytes, mediaType: "image/png" },
				],
			},
		];
		const msg = promptToCursorMessage(prompt);
		expect(msg.images).toHaveLength(1);
		expect(msg.images![0]).toEqual({
			data: Buffer.from(bytes).toString("base64"),
			mimeType: "image/png",
		});
		expect(msg.text).toContain("[image attached]");
	});

	it("passes through image URLs", () => {
		const prompt: LanguageModelV3Prompt = [
			{
				role: "user",
				content: [
					{
						type: "file",
						data: "https://example.com/a.png",
						mediaType: "image/png",
					},
				],
			},
		];
		const msg = promptToCursorMessage(prompt);
		expect(msg.images![0]).toEqual({ url: "https://example.com/a.png" });
	});
});

describe("latestUserMessage", () => {
	it("returns only the final user turn (for resuming a pooled agent)", () => {
		const prompt: LanguageModelV3Prompt = [
			{ role: "system", content: "be nice" },
			{ role: "user", content: [{ type: "text", text: "first" }] },
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
			{ role: "user", content: [{ type: "text", text: "second" }] },
		];
		expect(latestUserMessage(prompt)).toEqual({ text: "second" });
	});

	it("returns undefined when the last turn is not a user message", () => {
		const prompt: LanguageModelV3Prompt = [
			{ role: "user", content: [{ type: "text", text: "hi" }] },
			{ role: "assistant", content: [{ type: "text", text: "bye" }] },
		];
		expect(latestUserMessage(prompt)).toBeUndefined();
	});
});
