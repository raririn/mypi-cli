import type { generateImages as generateImagesOpenAICodexFunction } from "../../api/openai-codex-images.ts";
import type { generateImages as generateImagesOpenRouterFunction } from "../../api/openrouter-images.ts";
import { registerImagesApiProvider } from "../../images-api-registry.ts";
import type { AssistantImages, ImagesApi, ImagesContext, ImagesFunction, ImagesModel, ImagesOptions } from "../../types.ts";

interface OpenRouterImagesProviderModule {
	generateImages: typeof generateImagesOpenRouterFunction;
}

interface OpenAICodexImagesProviderModule {
	generateImages: typeof generateImagesOpenAICodexFunction;
}

let openRouterImagesProviderModulePromise: Promise<OpenRouterImagesProviderModule> | undefined;
let openAICodexImagesProviderModulePromise: Promise<OpenAICodexImagesProviderModule> | undefined;

function createLazyLoadErrorImages(model: ImagesModel<ImagesApi>, error: unknown): AssistantImages {
	return {
		api: model.api,
		provider: model.provider,
		model: model.id,
		output: [],
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

function loadOpenRouterImagesProviderModule(): Promise<OpenRouterImagesProviderModule> {
	openRouterImagesProviderModulePromise ||= import("../../api/openrouter-images.ts").then(
		(module) => module as OpenRouterImagesProviderModule,
	);
	return openRouterImagesProviderModulePromise;
}

function loadOpenAICodexImagesProviderModule(): Promise<OpenAICodexImagesProviderModule> {
	openAICodexImagesProviderModulePromise ||= import("../../api/openai-codex-images.ts").then(
		(module) => module as OpenAICodexImagesProviderModule,
	);
	return openAICodexImagesProviderModulePromise;
}

export const generateImagesOpenRouter: ImagesFunction<"openrouter-images", ImagesOptions> = async (
	model: ImagesModel<"openrouter-images">,
	context: ImagesContext,
	options?: ImagesOptions,
) => {
	try {
		const module = await loadOpenRouterImagesProviderModule();
		return await module.generateImages(model, context, options);
	} catch (error) {
		return createLazyLoadErrorImages(model, error);
	}
};

export const generateImagesOpenAICodex: ImagesFunction<"openai-codex-images", ImagesOptions> = async (
	model: ImagesModel<"openai-codex-images">,
	context: ImagesContext,
	options?: ImagesOptions,
) => {
	try {
		const module = await loadOpenAICodexImagesProviderModule();
		return await module.generateImages(model, context, options);
	} catch (error) {
		return createLazyLoadErrorImages(model, error);
	}
};

export function registerBuiltInImagesApiProviders(): void {
	registerImagesApiProvider({
		api: "openrouter-images",
		generateImages: generateImagesOpenRouter,
	});
	registerImagesApiProvider({
		api: "openai-codex-images",
		generateImages: generateImagesOpenAICodex,
	});
}

registerBuiltInImagesApiProviders();
