import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { serializeConversation } from "../src/core/compaction/utils.ts";

describe("serializeConversation", () => {
	it("should truncate long tool results", () => {
		const longContent = `${"h".repeat(3000)}${"t".repeat(1984)}TAIL-DIAGNOSTIC-`;
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: longContent }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toContain("[Tool result: read#tc1]:");
		expect(result).toContain("[... 2600 characters omitted from the middle ...]");
		expect(result).toContain("h".repeat(1440));
		expect(result).toContain("TAIL-DIAGNOSTIC");
		expect(result).toContain(`${"t".repeat(944)}TAIL-DIAGNOSTIC-`);
		expect(result).not.toContain("h".repeat(2000));
	});

	it("bounds large tool arguments while preserving identity and the argument tail", () => {
		const result = serializeConversation([
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "tc-write",
						name: "write",
						arguments: {
							path: "/tmp/checkpoint.txt",
							content: `${"a".repeat(5000)}FINAL-WRITE-CONTENT`,
						},
					},
				],
				api: "anthropic",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
		]);

		expect(result).toContain("write#tc-write(");
		expect(result).toContain("path=\"/tmp/checkpoint.txt\"");
		expect(result).toContain("FINAL-WRITE-CONTENT");
		expect(result).toContain("characters omitted from the middle");
		expect(result).not.toContain("a".repeat(2000));
	});

	it("should not truncate short tool results", () => {
		const shortContent = "x".repeat(1500);
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: shortContent }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toBe(`[Tool result: read#tc1]: ${shortContent}`);
		expect(result).not.toContain("truncated");
	});

	it("labels errors and preserves their diagnostic tail with a larger bound", () => {
		const content = `${"p".repeat(4500)}FINAL-ERROR: protected plan changed`;
		const result = serializeConversation([
			{
				role: "toolResult",
				toolCallId: "tc-error",
				toolName: "bash",
				content: [{ type: "text", text: content }],
				isError: true,
				timestamp: Date.now(),
			},
		]);

		expect(result).toContain("[Tool result: bash#tc-error, error]:");
		expect(result).toContain("FINAL-ERROR: protected plan changed");
		expect(result).toContain("characters omitted from the middle");
	});

	it("should not truncate assistant or user messages", () => {
		const longText = "y".repeat(5000);
		const messages: Message[] = [
			{
				role: "user",
				content: [{ type: "text", text: longText }],
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [{ type: "text", text: longText }],
				api: "anthropic",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).not.toContain("truncated");
		expect(result).toContain(longText);
	});

	it("keeps user provenance IDs stable across hierarchical segments", () => {
		const messages: Message[] = [
			{ role: "user", content: "third request", timestamp: Date.now() },
			{ role: "user", content: "fourth request", timestamp: Date.now() },
		];

		const result = serializeConversation(messages, { labelUserMessages: true, userIndexOffset: 2 });

		expect(result).toContain("[User U3]: third request");
		expect(result).toContain("[User U4]: fourth request");
		expect(result).not.toContain("[User U1]");
	});

	it("preserves image-only user-message provenance without embedding base64", () => {
		const result = serializeConversation(
			[
				{
					role: "user",
					content: [{ type: "image", mimeType: "image/png", data: "SECRET-BASE64-PAYLOAD" }],
					timestamp: Date.now(),
				},
			],
			{ labelUserMessages: true },
		);

		expect(result).toBe("[User U1]: [User image 1: image/png]");
		expect(result).not.toContain("SECRET-BASE64-PAYLOAD");
	});

	it("explicitly bounds a single enormous prose message while preserving its tail", () => {
		const result = serializeConversation(
			[{ role: "user", content: `${"h".repeat(80_000)}EXACT-USER-TAIL`, timestamp: Date.now() }],
			{ labelUserMessages: true },
		);

		expect(result).toContain("[User U1]");
		expect(result).toContain("characters omitted from the middle");
		expect(result).toContain("EXACT-USER-TAIL");
		expect(result.length).toBeLessThan(49_000);
	});
});
