import type { Agent } from "@earendil-works/pi-agent-core";
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	generateStructuredOutput,
	prepareStructuredOutputRequest,
	StructuredOutputError,
	validateStructuredOutputValue,
} from "../src/core/structured-output.ts";

const schema = {
	type: "object",
	properties: { answer: { type: "string" } },
	required: ["answer"],
	additionalProperties: false,
} as const;

function model(options?: { native?: boolean }): Model<any> {
	return {
		id: "structured-test",
		name: "Structured Test",
		api: options?.native ? "openai-responses" : "google-generative-ai",
		provider: options?.native ? "openai" : "test-provider",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

function message(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop") {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "test-provider",
		model: "structured-test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	} satisfies AssistantMessage;
}

function doneStream(result: AssistantMessage) {
	const stream = createAssistantMessageEventStream();
	stream.end(result);
	return stream;
}

function fakeAgent(
	selectedModel: Model<any>,
	streamFunction: (model: Model<any>, context: Context, options?: SimpleStreamOptions) => ReturnType<typeof doneStream>,
): Agent {
	return {
		state: {
			model: selectedModel,
			thinkingLevel: "off",
			systemPrompt: "Test system prompt",
			messages: [{ role: "user", content: "Give the answer", timestamp: Date.now() }],
		},
		convertToLlm: async (messages) => messages as Context["messages"],
		streamFunction,
		transport: "auto",
	} as unknown as Agent;
}

describe("structured output contract", () => {
	it("canonicalizes and hashes equivalent bounded schemas", () => {
		const left = prepareStructuredOutputRequest({ schema: { ...schema } });
		const right = prepareStructuredOutputRequest({
			schema: {
				additionalProperties: false,
				required: ["answer"],
				properties: { answer: { type: "string" } },
				type: "object",
			},
		});
		expect(left.schemaHash).toBe(right.schemaHash);
	});

	it("rejects unbounded or unsupported schemas before a provider call", () => {
		expect(() => prepareStructuredOutputRequest({ schema: { type: "array" } })).toThrow(StructuredOutputError);
		expect(() =>
			prepareStructuredOutputRequest({ schema: { type: "object", properties: {}, $ref: "https://example.com/schema" } }),
		).toThrow(/references are not supported/);
	});

	it("uses provider-native output and validates the returned JSON locally", async () => {
		let capturedOptions: SimpleStreamOptions | undefined;
		const agent = fakeAgent(model({ native: true }), (_model, _context, options) => {
			capturedOptions = options;
			return doneStream(message([{ type: "text", text: '{"answer":"native"}' }]));
		});
		const request = prepareStructuredOutputRequest({ schema: { ...schema }, requestId: "rpc-1" });
		const result = await generateStructuredOutput(agent, request, new AbortController().signal);

		expect(capturedOptions?.structuredOutput?.schema).toEqual(request.schema);
		expect(result).toMatchObject({ value: { answer: "native" }, method: "native", attempts: 1, requestId: "rpc-1" });
	});

	it("uses a bounded tool fallback and retries invalid values", async () => {
		let calls = 0;
		const agent = fakeAgent(model(), (_model, context) => {
			calls += 1;
			expect(context.tools?.[0]?.name).toBe("mypi_structured_result");
			return doneStream(
				message([
					{
						type: "toolCall",
						id: `call-${calls}`,
						name: "mypi_structured_result",
						arguments: calls === 1 ? { answer: 42 } : { answer: "fallback" },
					},
				]),
			);
		});
		const request = prepareStructuredOutputRequest({ schema: { ...schema }, maxValidationRetries: 1 });
		const result = await generateStructuredOutput(agent, request, new AbortController().signal);

		expect(result).toMatchObject({ value: { answer: "fallback" }, method: "tool", attempts: 2 });
	});

	it("falls back after a native-capable endpoint rejects the response format", async () => {
		let calls = 0;
		const agent = fakeAgent(model({ native: true }), (_model, context, options) => {
			calls += 1;
			if (options?.structuredOutput) {
				return doneStream(message([], "error"));
			}
			expect(context.tools?.[0]?.name).toBe("mypi_structured_result");
			return doneStream(
				message([
					{ type: "toolCall", id: "fallback", name: "mypi_structured_result", arguments: { answer: "recovered" } },
				]),
			);
		});
		const request = prepareStructuredOutputRequest({ schema: { ...schema } });
		const result = await generateStructuredOutput(agent, request, new AbortController().signal);

		expect(calls).toBe(2);
		expect(result).toMatchObject({ value: { answer: "recovered" }, method: "tool", attempts: 2 });
	});

	it("honors cancellation before starting finalization", async () => {
		let calls = 0;
		const agent = fakeAgent(model({ native: true }), () => {
			calls += 1;
			return doneStream(message([{ type: "text", text: '{"answer":"late"}' }]));
		});
		const controller = new AbortController();
		controller.abort();

		await expect(
			generateStructuredOutput(agent, prepareStructuredOutputRequest({ schema: { ...schema } }), controller.signal),
		).rejects.toMatchObject({ code: "aborted", attempts: 0 });
		expect(calls).toBe(0);
	});

	it("returns typed validation exhaustion instead of malformed JSON", async () => {
		const agent = fakeAgent(model(), () =>
			doneStream(
				message([
					{ type: "toolCall", id: "bad", name: "mypi_structured_result", arguments: { answer: 42 } },
				]),
			),
		);
		const request = prepareStructuredOutputRequest({ schema: { ...schema }, maxValidationRetries: 1 });

		await expect(generateStructuredOutput(agent, request, new AbortController().signal)).rejects.toMatchObject({
			code: "validation_exhausted",
			attempts: 2,
		});
	});

	it("reports local validation details", () => {
		const request = prepareStructuredOutputRequest({ schema: { ...schema } });
		expect(validateStructuredOutputValue(request, { answer: "ok" })).toEqual({ success: true });
		expect(validateStructuredOutputValue(request, { answer: 42 })).toMatchObject({ success: false });
	});
});
