import { OPENAI_CODEX_IMAGES_DEFAULT_BASE_URL } from "../api/openai-codex-images.ts";
import { openAICodexImagesApi } from "../api/openai-codex-images.lazy.ts";
import { lazyOAuth } from "../auth/helpers.ts";
import { loadOpenAICodexOAuth } from "../auth/oauth/load.ts";
import { createImagesProvider, type ImagesProvider } from "../images-models.ts";
import type { ImagesModel } from "../types.ts";

/**
 * Static catalog for the ChatGPT Codex image backend. Shares the `openai-codex`
 * provider id (and therefore the stored OAuth credential in auth.json) with the
 * chat provider, so resolveProviderAuth refreshes one token for both.
 */
export const OPENAI_CODEX_IMAGE_MODELS = {
	"gpt-image-2": {
		id: "gpt-image-2",
		name: "GPT Image 2",
		api: "openai-codex-images",
		provider: "openai-codex",
		baseUrl: OPENAI_CODEX_IMAGES_DEFAULT_BASE_URL,
		input: ["text", "image"],
		output: ["image"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
	} satisfies ImagesModel<"openai-codex-images">,
} as const;

export function openaiCodexImagesProvider(): ImagesProvider {
	return createImagesProvider({
		id: "openai-codex",
		name: "OpenAI Codex",
		auth: {
			oauth: lazyOAuth({ name: "OpenAI (ChatGPT Plus/Pro)", load: loadOpenAICodexOAuth }),
		},
		models: Object.values(OPENAI_CODEX_IMAGE_MODELS),
		api: openAICodexImagesApi(),
	});
}
