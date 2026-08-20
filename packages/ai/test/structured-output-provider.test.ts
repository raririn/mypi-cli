import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import type { Context, Model, StructuredOutputFormat } from "../src/types.ts";

const context: Context = {
	messages: [{ role: "user", content: "Return a result", timestamp: Date.now() }],
};

const format: StructuredOutputFormat = {
	type: "json_schema",
	name: "test_result",
	description: "A test result",
	schema: {
		type: "object",
		properties: { answer: { type: "string" } },
		required: ["answer"],
		additionalProperties: false,
	},
	strict: true,
};

function model<TApi extends Model<any>["api"]>(api: TApi, provider: string, compat?: Model<TApi>["compat"]): Model<TApi> {
	return {
		id: "structured-test",
		name: "Structured Test",
		api,
		provider,
		baseUrl: "https://example.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		compat,
	};
}

async function capturePayload(
	stream: (options: { onPayload: (payload: unknown) => never }) => { result(): Promise<unknown> },
): Promise<Record<string, unknown>> {
	let payload: Record<string, unknown> | undefined;
	await stream({
		onPayload: (value) => {
			payload = value as Record<string, unknown>;
			throw new Error("captured");
		},
	}).result();
	if (!payload) throw new Error("provider payload was not captured");
	return payload;
}

describe("provider-native structured output", () => {
	it("maps the generic format to OpenAI Responses text.format", async () => {
		const payload = await capturePayload((options) =>
			streamOpenAIResponses(model("openai-responses", "openai"), context, {
				apiKey: "test-key",
				structuredOutput: format,
				...options,
			}),
		);
		expect(payload.text).toEqual({
			format: {
				type: "json_schema",
				name: format.name,
				schema: format.schema,
				description: format.description,
				strict: true,
			},
		});
	});

	it("maps the generic format to OpenAI Chat Completions response_format", async () => {
		const payload = await capturePayload((options) =>
			streamOpenAICompletions(model("openai-completions", "openai"), context, {
				apiKey: "test-key",
				structuredOutput: format,
				...options,
			}),
		);
		expect(payload.response_format).toEqual({
			type: "json_schema",
			json_schema: {
				name: format.name,
				schema: format.schema,
				description: format.description,
				strict: true,
			},
		});
	});

	it("maps the generic format to Anthropic output_config.format", async () => {
		const payload = await capturePayload((options) =>
			streamAnthropic(model("anthropic-messages", "anthropic"), context, {
				apiKey: "test-key",
				structuredOutput: format,
				...options,
			}),
		);
		expect(payload.output_config).toEqual({ format: { type: "json_schema", schema: format.schema } });
	});

	it("honors an explicit compatible-provider opt-out", async () => {
		const payload = await capturePayload((options) =>
			streamOpenAIResponses(
				model("openai-responses", "compatible", { supportsStructuredOutputs: false }),
				context,
				{ apiKey: "test-key", structuredOutput: format, ...options },
			),
		);
		expect(payload.text).toBeUndefined();
	});
});
