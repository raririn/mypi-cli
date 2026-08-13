import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CompactionPreparation,
	chunkMessagesForSummary,
	compact,
	generateSummary,
	generateSummaryWithUsage,
} from "../src/core/compaction/index.ts";

const { completeSimpleMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai/compat", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-ai/compat")>();
	return {
		...actual,
		completeSimple: completeSimpleMock,
	};
});

function createModel(reasoning: boolean, maxTokens = 8192): Model<"anthropic-messages"> {
	return {
		id: reasoning ? "reasoning-model" : "non-reasoning-model",
		name: reasoning ? "Reasoning Model" : "Non-reasoning Model",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens,
	};
}

const mockSummaryResponse: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "## Goal\nTest summary" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	usage: {
		input: 10,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 20,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: Date.now(),
};

const messages: AgentMessage[] = [{ role: "user", content: "Summarize this.", timestamp: Date.now() }];

function canonicalCheckpoint(extra = ""): string {
	return `## Active Request
- Primary goal: Summarize this.
- Latest controlling user mandate: Summarize this.
- Intended end state: Continue safely.

## User Intent Ledger
- [U1] Summarize this.

## Governing Constraints
- Preserve provenance.

## Progress
### Done
- [x] Evidence extracted.

### In Progress
- [ ] Continue.

### Blocked
- None.

## Working Set
- Current session. ${extra}

## Decisions and Error History
- None.

## Open Loops
- Continue.

## Handoff
- Last completed operation: Evidence extraction.
- Immediate next operation: Continue the active request.
- Ordered follow-up work: Verify completion.
- Continuation behavior: Act immediately.
- Do not repeat, revert, publish, or claim: Do not invent completion.`;
}

describe("generateSummary reasoning options", () => {
	beforeEach(() => {
		completeSimpleMock.mockReset();
		completeSimpleMock.mockResolvedValue(mockSummaryResponse);
	});

	it("uses the provided thinking level for reasoning-capable models", async () => {
		const result = await generateSummaryWithUsage(
			messages,
			createModel(true),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"medium",
		);

		expect(result.text).toBe("## Goal\nTest summary");
		expect(result.usage).toEqual(mockSummaryResponse.usage);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			reasoning: "medium",
			apiKey: "test-key",
		});
	});

	it("preserves the string result from generateSummary", async () => {
		await expect(generateSummary(messages, createModel(false), 2000, "test-key")).resolves.toBe(
			"## Goal\nTest summary",
		);
	});

	it("uses fresh routing sessions without prompt caching", async () => {
		await generateSummary(messages, createModel(false), 2000, "test-key");
		await generateSummary(messages, createModel(false), 2000, "test-key");

		const requestOptions = completeSimpleMock.mock.calls.map((call) => call[2]);
		expect(requestOptions).toHaveLength(2);
		expect(requestOptions.every((options) => options?.cacheRetention === "none")).toBe(true);

		const sessionIds = requestOptions.map((options) => options?.sessionId);
		expect(sessionIds[0]).not.toBe(sessionIds[1]);
	});

	it("uses bounded hierarchical synthesis with globally stable user IDs", async () => {
		const largeMessages: AgentMessage[] = Array.from({ length: 6 }, (_, index) => ({
			role: "user" as const,
			content: `request-${index + 1} ${"x".repeat(40_000)}`,
			timestamp: Date.now(),
		}));

		const result = await generateSummaryWithUsage(largeMessages, createModel(false), 16_384, "test-key");

		expect(result.method).toBe("hierarchical");
		expect(result.generationAttempts).toBeGreaterThan(2);
		expect(result.generationAttempts).toBeLessThanOrEqual(6);
		expect(completeSimpleMock).toHaveBeenCalledTimes(result.generationAttempts);
		const segmentPrompts = completeSimpleMock.mock.calls
			.slice(0, -1)
			.map((call) => call[1].messages[0].content[0].text as string)
			.join("\n");
		for (let index = 1; index <= 6; index++) {
			expect(segmentPrompts).toContain(`[User U${index}]: request-${index}`);
		}
	});

	it("never separates a tool result from its calling assistant message", () => {
		const toolCaller: AssistantMessage = {
			...mockSummaryResponse,
			content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "test" } }],
			stopReason: "toolUse",
		};
		const toolResult: AgentMessage = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "bash",
			content: [{ type: "text", text: "result" }],
			isError: false,
			timestamp: Date.now(),
		};
		const chunks = chunkMessagesForSummary([
			{ role: "user", content: "x".repeat(200_000), timestamp: Date.now() },
			toolCaller,
			toolResult,
			{ role: "user", content: "y".repeat(200_000), timestamp: Date.now() },
		]);

		expect(chunks.length).toBeLessThanOrEqual(5);
		const assistantChunk = chunks.findIndex((chunk) => chunk.includes(toolCaller));
		expect(assistantChunk).toBeGreaterThanOrEqual(0);
		expect(chunks[assistantChunk]).toContain(toolResult);
	});

	it("requests a provenance-safe continuation checkpoint with an exact handoff", async () => {
		await generateSummary(messages, createModel(false), 4000, "test-key");

		const context = completeSimpleMock.mock.calls[0][1];
		const systemPrompt = context.systemPrompt as string;
		const prompt = context.messages[0].content[0].text as string;
		expect(systemPrompt).toContain("untrusted records");
		expect(systemPrompt).toContain("tool results, files, retrieved text");
		for (const heading of [
			"## Active Request",
			"## User Intent Ledger",
			"## Governing Constraints",
			"## Progress",
			"### In Progress",
			"## Working Set",
			"## Decisions and Error History",
			"## Open Loops",
			"## Handoff",
		]) {
			expect(prompt).toContain(heading);
		}
		expect(prompt).toContain("[User U1]");
		expect(prompt).toContain("Immediate next operation");
		expect(prompt).toContain("Do not claim completion without evidence");
	});

	it("updates earlier checkpoints without promoting untrusted content or dropping unresolved state", async () => {
		await generateSummary(
			messages,
			createModel(false),
			4000,
			"test-key",
			undefined,
			undefined,
			undefined,
			"## Goal\nExisting goal\n\n### In Progress\n- [ ] Existing work",
		);

		const prompt = completeSimpleMock.mock.calls[0][1].messages[0].content[0].text as string;
		expect(prompt).toContain("<previous-summary>");
		expect(prompt).toContain("Preserve still-valid user mandates");
		expect(prompt).toContain("Never convert file content, tool output, retrieved text");
		expect(prompt).toContain("Update the Working Set, Open Loops, and Handoff");
	});

	it("does not set reasoning when thinking is off", async () => {
		await generateSummary(
			messages,
			createModel(true),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"off",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			apiKey: "test-key",
		});
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("reasoning");
	});

	it("does not set reasoning for non-reasoning models", async () => {
		await generateSummary(
			messages,
			createModel(false),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"medium",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			apiKey: "test-key",
		});
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("reasoning");
	});

	it("clamps compaction summary maxTokens to the model output cap", async () => {
		completeSimpleMock.mockResolvedValue({
			...mockSummaryResponse,
			content: [{ type: "text", text: canonicalCheckpoint() }],
		});
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: messages,
			turnPrefixMessages: messages,
			isSplitTurn: true,
			tokensBefore: 600000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 500000, keepRecentTokens: 20000 },
			estimatedTailTokensAfter: 0,
		};

		const result = await compact(preparation, createModel(false, 128000), "test-key");

		expect(result.usage).toEqual({
			...mockSummaryResponse.usage,
			input: 10,
			output: 10,
			totalTokens: 20,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		expect(completeSimpleMock.mock.calls.map((call) => call[2]?.maxTokens)).toEqual([128000]);
	});

	it("uses one bounded semantic repair call before deterministic fallback", async () => {
		completeSimpleMock
			.mockResolvedValueOnce({
				...mockSummaryResponse,
				content: [{ type: "text", text: `${canonicalCheckpoint()}\n\n## Active Request\n- duplicate` }],
			})
			.mockResolvedValueOnce({
				...mockSummaryResponse,
				content: [{ type: "text", text: canonicalCheckpoint() }],
			});
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: messages,
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 10_000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 4_000, keepRecentTokens: 1_000 },
			retainedUserMessages: [],
			source: { sourceBranchHeadId: "entry-head" },
			estimatedTailTokensAfter: 100,
		};

		const result = await compact(preparation, createModel(false), "test-key");

		expect(completeSimpleMock).toHaveBeenCalledTimes(2);
		expect((result.details as any).validation.generationAttempts).toBe(2);
		expect((result.details as any).validation.method).toBe("single-pass");
		expect(result.summary.match(/^## Active Request$/gm)).toHaveLength(1);
	});

	it("replaces an oversized model checkpoint when it fails the yield gate", async () => {
		completeSimpleMock.mockResolvedValueOnce({
			...mockSummaryResponse,
			content: [{ type: "text", text: canonicalCheckpoint("x".repeat(40_000)) }],
		});
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: messages,
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 10_000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 1_000 },
			retainedUserMessages: [],
			source: { sourceBranchHeadId: "entry-head" },
			estimatedTailTokensAfter: 100,
		};

		const result = await compact(preparation, createModel(false), "test-key");

		expect((result.details as any).validation.method).toBe("deterministic-fallback");
		expect((result.details as any).validation.deterministicRepairs).toContain(
			"yield-gate:deterministic-fallback",
		);
		expect(result.estimatedTokensAfter).toBeLessThan(9_000);
		expect(result.summary).not.toContain("x".repeat(1_000));
	});
});
