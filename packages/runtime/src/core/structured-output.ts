import { createHash } from "node:crypto";
import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import type {
	AssistantMessage,
	Context,
	Model,
	StructuredOutputFormat,
	Tool,
	Usage,
} from "@earendil-works/pi-ai/compat";
import type { TSchema } from "typebox";
import { Compile } from "typebox/compile";

export const STRUCTURED_OUTPUT_SESSION_ENTRY = "mypi-structured-output";
export const STRUCTURED_OUTPUT_TOOL_NAME = "mypi_structured_result";

const MAX_SCHEMA_BYTES = 32 * 1024;
const MAX_SCHEMA_DEPTH = 12;
const MAX_SCHEMA_NODES = 256;
const MAX_SCHEMA_PROPERTIES = 128;
const MAX_SCHEMA_ENUM_VALUES = 100;
const MAX_SCHEMA_STRING_BYTES = 4096;
const MAX_RESULT_BYTES = 256 * 1024;
const DEFAULT_VALIDATION_RETRIES = 2;
const MAX_VALIDATION_RETRIES = 3;

export type StructuredOutputErrorCode =
	| "invalid_schema"
	| "schema_conflict"
	| "validation_exhausted"
	| "provider_error"
	| "aborted";

export interface StructuredOutputRequest {
	schema: Record<string, unknown>;
	name?: string;
	description?: string;
	maxValidationRetries?: number;
	/** Opaque surface correlation id. It is emitted but never persisted as schema identity. */
	requestId?: string;
}

export interface PreparedStructuredOutputRequest {
	schema: Record<string, unknown>;
	canonicalSchema: string;
	schemaHash: string;
	name: string;
	description?: string;
	maxValidationRetries: number;
	requestId?: string;
}

export interface StructuredOutputResult {
	value: unknown;
	schemaHash: string;
	method: "native" | "tool";
	attempts: number;
	usage: Usage;
	requestId?: string;
}

export interface StructuredOutputSchemaEntry {
	version: 1;
	kind: "schema";
	schemaHash: string;
	schema: Record<string, unknown>;
	name: string;
	description?: string;
}

export interface StructuredOutputValueEntry {
	version: 1;
	kind: "result";
	schemaHash: string;
	method: "native" | "tool";
	attempts: number;
	value: unknown;
	usage: Usage;
}

export class StructuredOutputError extends Error {
	readonly code: StructuredOutputErrorCode;
	readonly schemaHash?: string;
	readonly attempts?: number;
	readonly requestId?: string;

	constructor(
		code: StructuredOutputErrorCode,
		message: string,
		options?: { schemaHash?: string; attempts?: number; requestId?: string },
	) {
		super(message);
		this.name = "StructuredOutputError";
		this.code = code;
		this.schemaHash = options?.schemaHash;
		this.attempts = options?.attempts;
		this.requestId = options?.requestId;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function canonicalize(value: unknown, seen = new WeakSet<object>()): unknown {
	if (Array.isArray(value)) {
		if (seen.has(value)) throw new Error("cyclic arrays are not supported");
		seen.add(value);
		const result = value.map((entry) => canonicalize(entry, seen));
		seen.delete(value);
		return result;
	}
	if (!isRecord(value)) return value;
	if (seen.has(value)) throw new Error("cyclic objects are not supported");
	seen.add(value);
	const result: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key], seen);
	seen.delete(value);
	return result;
}

function inspectSchemaBounds(value: unknown): void {
	let nodes = 0;
	const seen = new WeakSet<object>();
	const visit = (candidate: unknown, depth: number): void => {
		if (depth > MAX_SCHEMA_DEPTH) throw new Error(`schema exceeds maximum depth ${MAX_SCHEMA_DEPTH}`);
		if (typeof candidate === "string" && byteLength(candidate) > MAX_SCHEMA_STRING_BYTES) {
			throw new Error(`schema contains a string larger than ${MAX_SCHEMA_STRING_BYTES} bytes`);
		}
		if (candidate === null || typeof candidate !== "object") return;
		if (seen.has(candidate)) throw new Error("schema must not contain cycles");
		seen.add(candidate);
		nodes += 1;
		if (nodes > MAX_SCHEMA_NODES) throw new Error(`schema exceeds ${MAX_SCHEMA_NODES} nodes`);
		if (Array.isArray(candidate)) {
			if (candidate.length > MAX_SCHEMA_ENUM_VALUES) {
				throw new Error(`schema array exceeds ${MAX_SCHEMA_ENUM_VALUES} entries`);
			}
			for (const entry of candidate) visit(entry, depth + 1);
		} else {
			const record = candidate as Record<string, unknown>;
			if (isRecord(record.properties) && Object.keys(record.properties).length > MAX_SCHEMA_PROPERTIES) {
				throw new Error(`schema exceeds ${MAX_SCHEMA_PROPERTIES} properties in one object`);
			}
			if (record.$ref !== undefined || record.$dynamicRef !== undefined || record.$recursiveRef !== undefined) {
				throw new Error("schema references are not supported in the bounded headless contract");
			}
			for (const [key, entry] of Object.entries(record)) {
				if (byteLength(key) > 256) throw new Error("schema contains an overlong property name");
				visit(entry, depth + 1);
			}
		}
		seen.delete(candidate);
	};
	visit(value, 0);
}

function normalizeFormatName(name: string | undefined): string {
	const candidate = name?.trim() || "mypi_result";
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(candidate)) {
		throw new Error("name must contain only letters, digits, underscores, or dashes and be at most 64 characters");
	}
	return candidate;
}

export function prepareStructuredOutputRequest(request: StructuredOutputRequest): PreparedStructuredOutputRequest {
	try {
		if (!isRecord(request) || !isRecord(request.schema)) throw new Error("schema must be a JSON object");
		if (request.schema.type !== "object") throw new Error('root schema type must be "object"');
		const canonicalSchema = JSON.stringify(canonicalize(request.schema));
		if (byteLength(canonicalSchema) > MAX_SCHEMA_BYTES) {
			throw new Error(`schema exceeds ${MAX_SCHEMA_BYTES} bytes`);
		}
		inspectSchemaBounds(request.schema);
		Compile(request.schema as TSchema);
		const name = normalizeFormatName(request.name);
		if (request.description !== undefined) {
			if (typeof request.description !== "string" || byteLength(request.description) > 1024) {
				throw new Error("description must be a string of at most 1024 bytes");
			}
		}
		const maxValidationRetries = request.maxValidationRetries ?? DEFAULT_VALIDATION_RETRIES;
		if (
			!Number.isInteger(maxValidationRetries) ||
			maxValidationRetries < 0 ||
			maxValidationRetries > MAX_VALIDATION_RETRIES
		) {
			throw new Error(`maxValidationRetries must be an integer from 0 to ${MAX_VALIDATION_RETRIES}`);
		}
		if (request.requestId !== undefined && (typeof request.requestId !== "string" || request.requestId.length > 256)) {
			throw new Error("requestId must be a string of at most 256 characters");
		}
		return {
			schema: JSON.parse(canonicalSchema) as Record<string, unknown>,
			canonicalSchema,
			schemaHash: createHash("sha256").update(canonicalSchema).digest("hex"),
			name,
			description: request.description,
			maxValidationRetries,
			requestId: request.requestId,
		};
	} catch (error) {
		if (error instanceof StructuredOutputError) throw error;
		throw new StructuredOutputError(
			"invalid_schema",
			`Invalid structured output schema: ${error instanceof Error ? error.message : String(error)}`,
			{ requestId: request.requestId },
		);
	}
}

export function validateStructuredOutputValue(
	request: PreparedStructuredOutputRequest,
	value: unknown,
): { success: true } | { success: false; message: string } {
	let serialized: string;
	try {
		serialized = JSON.stringify(value);
	} catch (error) {
		return { success: false, message: `result is not serializable: ${String(error)}` };
	}
	if (serialized === undefined) return { success: false, message: "result is not a JSON value" };
	if (byteLength(serialized) > MAX_RESULT_BYTES) {
		return { success: false, message: `result exceeds ${MAX_RESULT_BYTES} bytes` };
	}
	try {
		const validator = Compile(request.schema as TSchema);
		if (validator.Check(value)) return { success: true };
		const errors = Array.from(validator.Errors(value))
			.slice(0, 3)
			.map((error) => `${error.instancePath || "/"}: ${error.message}`)
			.join("; ");
		return { success: false, message: errors || "result does not match the schema" };
	} catch (error) {
		return { success: false, message: `schema validation failed: ${String(error)}` };
	}
}

export function modelSupportsNativeStructuredOutput(model: Model<any>): boolean {
	const configured = (model.compat as { supportsStructuredOutputs?: boolean } | undefined)?.supportsStructuredOutputs;
	if (model.api === "anthropic-messages") {
		return configured ?? model.provider === "anthropic";
	}
	if (model.api === "azure-openai-responses") {
		return configured ?? true;
	}
	if (model.api === "openai-responses" || model.api === "openai-completions") {
		return configured ?? model.provider === "openai";
	}
	return false;
}

function parseTextJson(message: AssistantMessage): unknown {
	const text = contentText(message.content).trim();
	if (!text) throw new Error("provider returned no structured text");
	return JSON.parse(text);
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function addUsage(target: Usage, usage: Usage): void {
	target.input += usage.input;
	target.output += usage.output;
	target.cacheRead += usage.cacheRead;
	target.cacheWrite += usage.cacheWrite;
	target.totalTokens += usage.totalTokens;
	target.reasoning = (target.reasoning ?? 0) + (usage.reasoning ?? 0);
	target.cost.input += usage.cost.input;
	target.cost.output += usage.cost.output;
	target.cost.cacheRead += usage.cost.cacheRead;
	target.cost.cacheWrite += usage.cost.cacheWrite;
	target.cost.total += usage.cost.total;
}

async function buildLlmMessages(agent: Agent, signal: AbortSignal): Promise<Context["messages"]> {
	let messages: AgentMessage[] = agent.state.messages;
	if (agent.transformContext) messages = await agent.transformContext(messages, signal);
	return await agent.convertToLlm(messages);
}

async function requestOnce(
	agent: Agent,
	context: Context,
	signal: AbortSignal,
	structuredOutput?: StructuredOutputFormat,
): Promise<AssistantMessage> {
	const model = agent.state.model;
	const apiKey = await agent.getApiKey?.(model.provider);
	const response = await agent.streamFunction(model, context, {
		apiKey,
		signal,
		sessionId: agent.sessionId,
		transport: agent.transport,
		thinkingBudgets: agent.thinkingBudgets,
		maxRetryDelayMs: agent.maxRetryDelayMs,
		onPayload: agent.onPayload,
		onResponse: agent.onResponse,
		reasoning: agent.state.thinkingLevel === "off" ? undefined : agent.state.thinkingLevel,
		structuredOutput,
	});
	return await response.result();
}

export async function generateStructuredOutput(
	agent: Agent,
	request: PreparedStructuredOutputRequest,
	signal: AbortSignal,
): Promise<StructuredOutputResult> {
	const messages = await buildLlmMessages(agent, signal);
	const usage = emptyUsage();
	let attempts = 0;
	let lastProblem = "the model did not return a structured result";
	let sawProviderSuccess = false;
	if (signal.aborted) {
		throw new StructuredOutputError("aborted", "Structured output generation was aborted.", {
			schemaHash: request.schemaHash,
			attempts,
			requestId: request.requestId,
		});
	}

	const instruction =
		"Return the authoritative final result for the completed user request. Do not perform more work or call ordinary tools.";

	if (modelSupportsNativeStructuredOutput(agent.state.model)) {
		attempts += 1;
		const nativeMessage = await requestOnce(
			agent,
			{
				systemPrompt: agent.state.systemPrompt,
				messages: [...messages, { role: "user", content: `${instruction} Return only schema-compliant JSON.`, timestamp: Date.now() }],
			},
			signal,
			{
				type: "json_schema",
				name: request.name,
				schema: request.schema,
				description: request.description,
				strict: true,
			},
		);
		addUsage(usage, nativeMessage.usage);
		if (nativeMessage.stopReason === "aborted" || signal.aborted) {
			throw new StructuredOutputError("aborted", "Structured output generation was aborted.", {
				schemaHash: request.schemaHash,
				attempts,
				requestId: request.requestId,
			});
		}
		if (nativeMessage.stopReason !== "error") {
			sawProviderSuccess = true;
			try {
				const value = parseTextJson(nativeMessage);
				const validation = validateStructuredOutputValue(request, value);
				if (validation.success) {
					return { value, schemaHash: request.schemaHash, method: "native", attempts, usage, requestId: request.requestId };
				}
				lastProblem = validation.message;
			} catch (error) {
				lastProblem = error instanceof Error ? error.message : String(error);
			}
		} else {
			lastProblem = nativeMessage.errorMessage ?? "native structured output request failed";
		}
	}

	const resultTool: Tool = {
		name: STRUCTURED_OUTPUT_TOOL_NAME,
		description: "Return the authoritative final structured result. Call this exactly once as the final action.",
		parameters: request.schema as TSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
	};
	const fallbackAttempts = request.maxValidationRetries + 1;
	for (let fallbackAttempt = 0; fallbackAttempt < fallbackAttempts; fallbackAttempt += 1) {
		if (signal.aborted) {
			throw new StructuredOutputError("aborted", "Structured output generation was aborted.", {
				schemaHash: request.schemaHash,
				attempts,
				requestId: request.requestId,
			});
		}
		attempts += 1;
		const correction = fallbackAttempt === 0 ? "" : ` The previous attempt was invalid: ${lastProblem}.`;
		const message = await requestOnce(
			agent,
			{
				systemPrompt: agent.state.systemPrompt,
				messages: [
					...messages,
					{
						role: "user",
						content: `${instruction} Call ${STRUCTURED_OUTPUT_TOOL_NAME} with the complete result.${correction}`,
						timestamp: Date.now(),
					},
				],
				tools: [resultTool],
			},
			signal,
		);
		addUsage(usage, message.usage);
		if (message.stopReason === "aborted" || signal.aborted) {
			throw new StructuredOutputError("aborted", "Structured output generation was aborted.", {
				schemaHash: request.schemaHash,
				attempts,
				requestId: request.requestId,
			});
		}
		if (message.stopReason === "error") {
			lastProblem = message.errorMessage ?? "structured output provider request failed";
			continue;
		}
		sawProviderSuccess = true;
		const calls = message.content.filter(
			(content): content is Extract<AssistantMessage["content"][number], { type: "toolCall" }> =>
				content.type === "toolCall" && content.name === STRUCTURED_OUTPUT_TOOL_NAME,
		);
		if (calls.length !== 1) {
			lastProblem = `expected exactly one ${STRUCTURED_OUTPUT_TOOL_NAME} call, received ${calls.length}`;
			continue;
		}
		const value = calls[0].arguments;
		const validation = validateStructuredOutputValue(request, value);
		if (!validation.success) {
			lastProblem = validation.message;
			continue;
		}
		return { value, schemaHash: request.schemaHash, method: "tool", attempts, usage, requestId: request.requestId };
	}

	throw new StructuredOutputError(
		sawProviderSuccess ? "validation_exhausted" : "provider_error",
		`Structured output failed after ${attempts} attempt${attempts === 1 ? "" : "s"}: ${lastProblem}`,
		{ schemaHash: request.schemaHash, attempts, requestId: request.requestId },
	);
}
