import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type ProviderStreams,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { cloudflareStreams, resolveCloudflareModel } from "@earendil-works/pi-ai/providers/cloudflare-stream";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

type CapturedRequest = {
	model: Model<Api>;
	options?: SimpleStreamOptions;
};

function createDoneStream(model: Model<Api>) {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
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
	};
	stream.end(message);
	return stream;
}

async function createCloudflareRuntime(): Promise<{ modelRuntime: ModelRuntime; modelRegistry: ModelRegistry }> {
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify("cloudflare-ai-gateway", async () => ({
		type: "api_key",
		key: "test-token",
		env: {
			CLOUDFLARE_ACCOUNT_ID: "test-account",
			CLOUDFLARE_GATEWAY_ID: "test-gateway",
		},
	}));
	const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null });
	return { modelRuntime, modelRegistry: new ModelRegistry(modelRuntime) };
}

describe("ModelRegistry Cloudflare compat streaming", () => {
	it("materializes the Cloudflare endpoint through ModelRuntime streaming", async () => {
		const { modelRuntime } = await createCloudflareRuntime();
		const model = modelRuntime.getModel("cloudflare-ai-gateway", "workers-ai/@cf/moonshotai/kimi-k2.5");
		const provider = modelRuntime.getProvider("cloudflare-ai-gateway");
		expect(model).toBeDefined();
		expect(provider).toBeDefined();
		if (!model || !provider) throw new Error("Cloudflare provider fixture is unavailable");

		let captured: CapturedRequest | undefined;
		const captureStreams: ProviderStreams = {
			stream: (requestModel, _context, options) => {
				captured = { model: requestModel, options: options as SimpleStreamOptions | undefined };
				return createDoneStream(requestModel);
			},
			streamSimple: (requestModel, _context, options) => {
				captured = { model: requestModel, options };
				return createDoneStream(requestModel);
			},
		};
		const wrapped = cloudflareStreams(captureStreams);
		modelRuntime.registerNativeProvider({
			id: provider.id,
			name: provider.name,
			auth: provider.auth,
			getModels: () => provider.getModels(),
			stream: wrapped.stream,
			streamSimple: wrapped.streamSimple,
		});

		await modelRuntime.completeSimple(model, { messages: [] });

		expect(captured?.model.baseUrl).toBe(
			"https://gateway.ai.cloudflare.com/v1/test-account/test-gateway/compat",
		);
		expect(captured?.options?.headers?.["cf-aig-authorization"]).toBe("Bearer test-token");
	});

	it("materializes the Cloudflare endpoint after extension-style auth resolution", async () => {
		const { modelRegistry } = await createCloudflareRuntime();
		const model = modelRegistry.find("cloudflare-ai-gateway", "workers-ai/@cf/moonshotai/kimi-k2.5");
		expect(model).toBeDefined();
		if (!model) throw new Error("Cloudflare model fixture is unavailable");

		const auth = await modelRegistry.getApiKeyAndHeaders(model);
		expect(auth).toEqual({
			ok: true,
			headers: { "cf-aig-authorization": "Bearer test-token" },
			env: {
				CLOUDFLARE_ACCOUNT_ID: "test-account",
				CLOUDFLARE_GATEWAY_ID: "test-gateway",
			},
		});
		if (!auth.ok) throw new Error(auth.error);

		expect(resolveCloudflareModel(model, auth.env).baseUrl).toBe(
			"https://gateway.ai.cloudflare.com/v1/test-account/test-gateway/compat",
		);
	});
});
