import type { ImagesModel, ProviderImages } from "../types.ts";

export const openAICodexImagesApi = (): ProviderImages => ({
	generateImages: async (model, context, options) =>
		(await import("./openai-codex-images.ts")).generateImages(
			model as ImagesModel<"openai-codex-images">,
			context,
			options,
		),
});
