import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { LanguageModelV3Prompt } from "@ai-sdk/provider";
import {
	latestUserMessage,
	promptToCursorMessage,
	trailingUserMessages,
} from "../src/provider/message-map.js";

/** Write a temp file and return its absolute path + file:// URL string. */
function tempFile(name: string, bytes: Buffer): { path: string; url: string } {
	const dir = mkdtempSync(join(tmpdir(), "cursor-msgmap-"));
	const path = join(dir, name);
	writeFileSync(path, bytes);
	return { path, url: pathToFileURL(path).href };
}

const PNG_BYTES = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
	"base64",
);

describe("promptToCursorMessage", () => {
	it("omits the system prompt from the transcript by default (rules mode)", () => {
		const prompt: LanguageModelV3Prompt = [
			{ role: "system", content: "Be concise." },
			{ role: "user", content: [{ type: "text", text: "Hello" }] },
			{ role: "assistant", content: [{ type: "text", text: "Hi there" }] },
			{ role: "user", content: [{ type: "text", text: "What is 2+2?" }] },
		];
		const msg = promptToCursorMessage(prompt);
		// System prompt is delivered via the Cursor rules channel, not inline.
		expect(msg.text).not.toContain("# System");
		expect(msg.text).not.toContain("Be concise.");
		expect(msg.text).toContain("# User\nHello");
		expect(msg.text).toContain("# Assistant\nHi there");
		expect(msg.text).toContain("# User\nWhat is 2+2?");
		expect(msg.images).toBeUndefined();
	});

	it("includes the system prompt inline in 'message' (legacy) mode", () => {
		const prompt: LanguageModelV3Prompt = [
			{ role: "system", content: "Be concise." },
			{ role: "user", content: [{ type: "text", text: "Hi" }] },
		];
		const msg = promptToCursorMessage(prompt, "message");
		expect(msg.text).toContain("# System\nBe concise.");
	});

	it("omits the system prompt in 'omit' mode", () => {
		const prompt: LanguageModelV3Prompt = [
			{ role: "system", content: "Be concise." },
			{ role: "user", content: [{ type: "text", text: "Hi" }] },
		];
		const msg = promptToCursorMessage(prompt, "omit");
		expect(msg.text).not.toContain("Be concise.");
		expect(msg.text).toBe("# User\nHi");
	});

	// Cursor's LOCAL SDK agent (the only backend the chat path uses) cannot
	// accept images in any form: `{url}` throws "URL images are only supported
	// for cloud SDK agents", and `{data,mimeType}` base64 fails the run with an
	// empty `status:"error"` (the "Cursor run ended with status error" a user
	// hits on an `@image` mention). So we never populate `images`; instead every
	// file part is surfaced as a text note so the run always completes.
	it("never attaches images; notes an image file part as text", () => {
		const bytes = new Uint8Array([1, 2, 3, 4]);
		const prompt: LanguageModelV3Prompt = [
			{
				role: "user",
				content: [
					{ type: "text", text: "Describe this" },
					{
						type: "file",
						data: bytes,
						mediaType: "image/png",
						filename: "shot.png",
					},
				],
			},
		];
		const msg = promptToCursorMessage(prompt);
		expect(msg.images).toBeUndefined();
		expect(msg.text).toContain("shot.png");
		expect(msg.text).toContain("image/png");
	});

	it("includes tool outputs (truncated) instead of dropping them", () => {
		const bigOutput = "x".repeat(5000);
		const prompt: LanguageModelV3Prompt = [
			{
				role: "assistant",
				content: [
					{
						type: "tool-call",
						toolCallId: "c1",
						toolName: "read",
						input: { path: "/a.ts" },
					} as never,
					{
						type: "tool-result",
						toolCallId: "c1",
						toolName: "read",
						output: { type: "text", value: bigOutput },
					} as never,
				],
			},
		];
		const msg = promptToCursorMessage(prompt);
		expect(msg.text).toContain('[called read({"path":"/a.ts"})]');
		expect(msg.text).toContain("[result of read:");
		// Output is present but capped well under its 5000-char size.
		expect(msg.text).toContain("chars]");
		expect(msg.text.length).toBeLessThan(3000);
	});

	it("caps tool-role result JSON", () => {
		const prompt: LanguageModelV3Prompt = [
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "c1",
						toolName: "grep",
						output: { type: "text", value: "y".repeat(5000) },
					} as never,
				],
			},
		];
		const msg = promptToCursorMessage(prompt);
		expect(msg.text).toContain("# Tool result (grep)");
		expect(msg.text).toContain("chars]");
		expect(msg.text.length).toBeLessThan(3000);
	});

	it("notes an http(s) image URL as text without attaching it", () => {
		const prompt: LanguageModelV3Prompt = [
			{
				role: "user",
				content: [
					{
						type: "file",
						data: "https://example.com/a.png",
						mediaType: "image/png",
						filename: "a.png",
					},
				],
			},
		];
		const msg = promptToCursorMessage(prompt);
		expect(msg.images).toBeUndefined();
		expect(msg.text).toContain("a.png");
	});

	it("notes a file:// image URL (URL object) as text, never as an image", () => {
		const { url } = tempFile("px.png", PNG_BYTES);
		const prompt: LanguageModelV3Prompt = [
			{
				role: "user",
				content: [
					{ type: "text", text: "look" },
					{
						type: "file",
						data: new URL(url),
						mediaType: "image/png",
						filename: "px.png",
					},
				],
			},
		];
		const msg = promptToCursorMessage(prompt);
		expect(msg.images).toBeUndefined();
		expect(msg.text).toContain("px.png");
	});

	it("notes a data: URI image as text, never as an image", () => {
		const b64 = PNG_BYTES.toString("base64");
		const prompt: LanguageModelV3Prompt = [
			{
				role: "user",
				content: [
					{
						type: "file",
						data: `data:image/png;base64,${b64}`,
						mediaType: "image/png",
						filename: "inline.png",
					},
				],
			},
		];
		const msg = promptToCursorMessage(prompt);
		expect(msg.images).toBeUndefined();
		expect(msg.text).toContain("inline.png");
	});

	it("notes a non-image file attachment as text instead of dropping it", () => {
		const { url } = tempFile("doc.pdf", Buffer.from("%PDF-1.4\n"));
		const prompt: LanguageModelV3Prompt = [
			{
				role: "user",
				content: [
					{ type: "text", text: "summarize" },
					{
						type: "file",
						data: new URL(url),
						mediaType: "application/pdf",
						filename: "doc.pdf",
					},
				],
			},
		];
		const msg = promptToCursorMessage(prompt);
		expect(msg.images).toBeUndefined();
		expect(msg.text).toContain("doc.pdf");
		expect(msg.text).toContain("application/pdf");
	});

	it("notes a directory @-mention as text instead of failing the turn", () => {
		const { url } = tempFile("readme.md", Buffer.from("# hi\n"));
		const dirUrl = url.slice(0, url.lastIndexOf("/")); // parent dir file:// URL
		const prompt: LanguageModelV3Prompt = [
			{
				role: "user",
				content: [
					{ type: "text", text: "what's in here?" },
					{
						type: "file",
						data: new URL(dirUrl),
						mediaType: "application/x-directory",
						filename: "src",
					},
				],
			},
		];
		const msg = promptToCursorMessage(prompt);
		expect(msg.images).toBeUndefined();
		expect(msg.text).toContain("src");
		expect(msg.text).toContain("application/x-directory");
	});

	it("falls back to the filesystem path when a file:// part has no filename", () => {
		const { path, url } = tempFile("noname.bin", Buffer.from([0, 1, 2]));
		const prompt: LanguageModelV3Prompt = [
			{
				role: "user",
				content: [
					{
						type: "file",
						data: new URL(url),
						mediaType: "application/octet-stream",
					},
				],
			},
		];
		const msg = promptToCursorMessage(prompt);
		expect(msg.images).toBeUndefined();
		// No filename → the note identifies the file by its filesystem path
		// (not the file:// href) so the local agent's workspace tools can act
		// on it directly.
		expect(msg.text).toContain(path);
		expect(msg.text).not.toContain("file://");
		expect(msg.text).toContain("application/octet-stream");
	});

	it("uses an http URL string as the name when a file part has no filename", () => {
		const prompt: LanguageModelV3Prompt = [
			{
				role: "user",
				content: [
					{
						type: "file",
						data: "https://example.com/pic.png",
						mediaType: "image/png",
					},
				],
			},
		];
		const msg = promptToCursorMessage(prompt);
		expect(msg.images).toBeUndefined();
		expect(msg.text).toContain("https://example.com/pic.png");
	});

	it("never inlines raw base64 string data; falls back to a generic name", () => {
		const b64 = PNG_BYTES.toString("base64");
		const prompt: LanguageModelV3Prompt = [
			{
				role: "user",
				content: [
					{
						type: "file",
						// Raw base64 with no data: prefix and no filename — must NOT
						// end up verbatim in the note text.
						data: b64,
						mediaType: "image/png",
					},
				],
			},
		];
		const msg = promptToCursorMessage(prompt);
		expect(msg.images).toBeUndefined();
		expect(msg.text).not.toContain(b64);
		expect(msg.text).toContain("[attached file: file (image/png)");
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

	it("notes an image in the final user turn as text, never as an image", () => {
		const { url } = tempFile("px.png", PNG_BYTES);
		const prompt: LanguageModelV3Prompt = [
			{
				role: "user",
				content: [
					{ type: "text", text: "look" },
					{
						type: "file",
						data: new URL(url),
						mediaType: "image/png",
						filename: "px.png",
					},
				],
			},
		];
		const msg = latestUserMessage(prompt);
		expect(msg?.images).toBeUndefined();
		expect(msg?.text).toContain("px.png");
	});

	it("notes a non-image attachment in the final user turn as text", () => {
		const { url } = tempFile("doc.pdf", Buffer.from("%PDF-1.4\n"));
		const prompt: LanguageModelV3Prompt = [
			{
				role: "user",
				content: [
					{ type: "text", text: "summarize" },
					{
						type: "file",
						data: new URL(url),
						mediaType: "application/pdf",
						filename: "doc.pdf",
					},
				],
			},
		];
		const msg = latestUserMessage(prompt);
		expect(msg?.images).toBeUndefined();
		expect(msg?.text).toContain("doc.pdf");
	});

	it("notes a directory @-mention in the final user turn as text", () => {
		const { url } = tempFile("readme.md", Buffer.from("# hi\n"));
		const dirUrl = url.slice(0, url.lastIndexOf("/"));
		const prompt: LanguageModelV3Prompt = [
			{
				role: "user",
				content: [
					{ type: "text", text: "what's in here?" },
					{
						type: "file",
						data: new URL(dirUrl),
						mediaType: "application/x-directory",
						filename: "src",
					},
				],
			},
		];
		const msg = latestUserMessage(prompt);
		expect(msg?.images).toBeUndefined();
		expect(msg?.text).toContain("src");
		expect(msg?.text).toContain("application/x-directory");
	});
});

describe("trailingUserMessages", () => {
	it("returns the last N user turns in conversation order", () => {
		const prompt: LanguageModelV3Prompt = [
			{ role: "system", content: "S" },
			{ role: "user", content: [{ type: "text", text: "a" }] },
			{ role: "assistant", content: [{ type: "text", text: "x" }] },
			{ role: "user", content: [{ type: "text", text: "b" }] },
			{ role: "user", content: [{ type: "text", text: "c" }] },
		];
		expect(trailingUserMessages(prompt, 2)).toEqual([
			{ text: "b" },
			{ text: "c" },
		]);
	});

	it("notes files on trailing turns the same way latestUserMessage does", () => {
		const prompt: LanguageModelV3Prompt = [
			{ role: "user", content: [{ type: "text", text: "first" }] },
			{
				role: "user",
				content: [
					{ type: "text", text: "look" },
					{
						type: "file",
						data: "https://x/a.png",
						mediaType: "image/png",
					},
				],
			},
		];
		const [msg] = trailingUserMessages(prompt, 1);
		expect(msg?.images).toBeUndefined();
		expect(msg?.text).toContain("look");
		expect(msg?.text).toContain(
			"[attached file: https://x/a.png (image/png) — not forwarded to Cursor]",
		);
	});

	it("returns only the available user turns when fewer than N exist", () => {
		const prompt: LanguageModelV3Prompt = [
			{ role: "user", content: [{ type: "text", text: "only" }] },
		];
		expect(trailingUserMessages(prompt, 3)).toEqual([{ text: "only" }]);
	});

	it("returns an empty array when the final turn is not a user message", () => {
		const prompt: LanguageModelV3Prompt = [
			{ role: "user", content: [{ type: "text", text: "hi" }] },
			{ role: "assistant", content: [{ type: "text", text: "bye" }] },
		];
		expect(trailingUserMessages(prompt, 2)).toEqual([]);
	});
});
