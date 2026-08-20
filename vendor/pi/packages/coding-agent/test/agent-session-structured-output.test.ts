import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import {
	createAssistantMessageEventStream,
	getModel,
	type AssistantMessage,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession, type AgentSessionEvent } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { StructuredOutputError } from "../src/core/structured-output.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

const schema = {
	type: "object",
	properties: { answer: { type: "string" } },
	required: ["answer"],
	additionalProperties: false,
} as const;

function message(text: string, options?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5.4-mini",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...options,
	};
}

function done(result: AssistantMessage) {
	const stream = createAssistantMessageEventStream();
	stream.end(result);
	return stream;
}

describe("AgentSession structured output", () => {
	let tempDir: string;
	let session: AgentSession | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `mypi-structured-session-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		session?.dispose();
		rmSync(tempDir, { recursive: true, force: true });
	});

	async function createSession(
		finalizer: (options?: SimpleStreamOptions) => AssistantMessage = () => message('{"answer":"done"}'),
		holdFirstRun = false,
	) {
		const selectedModel = getModel("openai", "gpt-5.4-mini")!;
		let calls = 0;
		let releaseFirstRun: (() => void) | undefined;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: selectedModel, systemPrompt: "Test", tools: [] },
			streamFn: (_model, _context, options) => {
				calls += 1;
				if (options?.structuredOutput) return done(finalizer(options));
				if (holdFirstRun && !releaseFirstRun) {
					const stream = createAssistantMessageEventStream();
					releaseFirstRun = () => stream.end(message("ordinary answer"));
					return stream;
				}
				return done(message("ordinary answer"));
			},
		});
		const sessionManager = SessionManager.inMemory(tempDir);
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		await authStorage.modify("openai", async () => ({ type: "api_key", key: "test-key" }));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
		});
		return { session, sessionManager, getCalls: () => calls, releaseFirstRun: () => releaseFirstRun?.() };
	}

	it("persists the schema/result and emits the typed result before settlement", async () => {
		const fixture = await createSession();
		const events: AgentSessionEvent[] = [];
		fixture.session.subscribe((event) => events.push(event));

		const result = await fixture.session.promptStructured("Answer", { schema: { ...schema }, requestId: "sdk-1" });

		expect(result).toMatchObject({ value: { answer: "done" }, method: "native", requestId: "sdk-1" });
		const resultIndex = events.findIndex((event) => event.type === "structured_result");
		const settledIndex = events.findIndex((event) => event.type === "agent_settled");
		expect(resultIndex).toBeGreaterThanOrEqual(0);
		expect(settledIndex).toBeGreaterThan(resultIndex);
		const entries = fixture.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === "mypi-structured-output");
		expect(entries.map((entry) => (entry.data as { kind: string }).kind)).toEqual(["schema", "result"]);
		expect(fixture.session.getSessionStats().tokens).toMatchObject({ input: 2, output: 2, total: 4 });
	});

	it("accepts the exact schema on follow-up and rejects a conflicting schema before another provider run", async () => {
		const fixture = await createSession();
		await fixture.session.promptStructured("First", { schema: { ...schema } });
		await fixture.session.promptStructured("Second", { schema: { ...schema } });
		expect(fixture.getCalls()).toBe(4);

		await expect(
			fixture.session.promptStructured("Conflict", {
				schema: {
					type: "object",
					properties: { count: { type: "number" } },
					required: ["count"],
					additionalProperties: false,
				},
			}),
		).rejects.toMatchObject({ code: "schema_conflict" });
		expect(fixture.getCalls()).toBe(4);
	});

	it("emits typed validation exhaustion and settles the run as an error", async () => {
		const fixture = await createSession(() => message('{"answer":42}'));
		const events: AgentSessionEvent[] = [];
		fixture.session.subscribe((event) => events.push(event));

		await expect(
			fixture.session.promptStructured("Answer", { schema: { ...schema }, maxValidationRetries: 0 }),
		).rejects.toBeInstanceOf(StructuredOutputError);
		expect(events.find((event) => event.type === "structured_result_error")).toMatchObject({
			type: "structured_result_error",
			error: { code: "validation_exhausted" },
		});
		expect(events.at(-1)).toMatchObject({ type: "agent_settled", outcome: { kind: "error" } });
	});

	it("keeps plain queued follow-ups in the active contract and rejects a second queued schema request", async () => {
		const fixture = await createSession(undefined, true);
		const first = fixture.session.promptStructured("First", { schema: { ...schema }, requestId: "first" });
		for (let attempt = 0; attempt < 50 && !fixture.session.isStreaming; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 2));
		}
		expect(fixture.session.isStreaming).toBe(true);
		await expect(
			fixture.session.prompt("queued", { streamingBehavior: "followUp", structuredOutput: { schema: { ...schema } } }),
		).rejects.toMatchObject({ code: "schema_conflict" });
		await expect(fixture.session.prompt("plain queued", { streamingBehavior: "followUp" })).resolves.toBeUndefined();
		fixture.releaseFirstRun();
		await expect(first).resolves.toMatchObject({ value: { answer: "done" }, requestId: "first" });
	});
});
