import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model, Provider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { FileModelsStore } from "../src/core/models-store.ts";

const providerId = "external-dynamic";
const model: Model<"openai-completions"> = {
	id: "external-model",
	name: "External Model",
	api: "openai-completions",
	provider: providerId,
	baseUrl: "https://example.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_384,
};

function dynamicProvider(refreshModes: boolean[]): Provider<"openai-completions"> {
	let models: Model<"openai-completions">[] = [];
	return {
		id: providerId,
		name: "External Dynamic",
		auth: {
			apiKey: {
				name: "External key",
				async check({ credential }) {
					return credential?.key ? { type: "api_key", source: "stored credential" } : undefined;
				},
				async resolve({ credential }) {
					return credential?.key
						? { auth: { apiKey: credential.key }, source: "stored credential" }
						: undefined;
				},
			},
		},
		getModels: () => models,
		async refreshModels(context) {
			refreshModes.push(context.allowNetwork);
			if (context.credential?.type !== "api_key") return;
			const stored = await context.store.read();
			models = (stored?.models ?? []) as Model<"openai-completions">[];
		},
		stream() {
			throw new Error("not used");
		},
		streamSimple() {
			throw new Error("not used");
		},
	};
}

describe("ModelRuntime external persisted state", () => {
	it("reloads an externally saved credential and dynamic catalog without network access", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "mypi-external-model-state-"));
		const authPath = join(agentDir, "auth.json");
		const modelsPath = join(agentDir, "models.json");
		const modelsStorePath = join(agentDir, "models-store.json");
		const refreshModes: boolean[] = [];
		try {
			const runtime = await ModelRuntime.create({ authPath, modelsPath, modelsStorePath });
			runtime.registerNativeProvider(dynamicProvider(refreshModes));
			await runtime.refresh({ allowNetwork: false });
			expect(await runtime.getAvailable(providerId)).toEqual([]);

			// A hosted surface owns login and discovery while this engine remains alive.
			await AuthStorage.create(authPath).modify(providerId, async () => ({ type: "api_key", key: "external-key" }));
			await new FileModelsStore(modelsStorePath).write(providerId, { models: [model], checkedAt: Date.now() });

			runtime.reloadCredentials();
			expect(await runtime.getAvailable(providerId)).toEqual([]);

			await runtime.reloadPersistedModelState();
			expect(await runtime.getAvailable(providerId)).toEqual([model]);
			expect(refreshModes.at(-1)).toBe(false);
		} finally {
			if (existsSync(agentDir)) rmSync(agentDir, { recursive: true, force: true });
		}
	});
});
