/**
 * generate_image — agent tool backed by OpenAI's Codex image backend
 * (gpt-image-2) using the user's existing `openai-codex` OAuth credential.
 *
 * The tool is advertised ONLY when both hold:
 *   (a) config enables it: `shared.imageGen.provider: openai-codex` in the
 *       unified config.yaml (Settings.imageGen via SettingsManager), and
 *   (b) auth.json holds an `openai-codex` OAuth credential.
 *
 * Generation flows through pi-ai's images framework (ImagesModels +
 * openaiCodexImagesProvider), so token refresh rides resolveProviderAuth. On
 * an HTTP 401 the stored credential is force-expired once and the request is
 * retried, which routes through a fresh OAuth refresh.
 *
 * Returned images are written to `<cwd>/generated-images/img-<ts>-<n>.png`
 * and also returned as image content blocks so the TUI (kitty/iterm) and GUI
 * render them inline.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createImagesModels, type ImagesApi, type ImagesModel, type MutableImagesModels, Type } from "@earendil-works/pi-ai";
import type { OpenAICodexImagesOptions } from "@earendil-works/pi-ai/api/openai-codex-images";
import {
	OPENAI_CODEX_IMAGE_MODELS,
	openaiCodexImagesProvider,
} from "@earendil-works/pi-ai/providers/openai-codex-images";
import { getAgentDir } from "../config.ts";
import { AuthStorage, readStoredCredential } from "../core/auth-storage.ts";
import type { ExtensionAPI } from "../core/extensions/types.ts";
import { SettingsManager } from "../core/settings-manager.ts";

export const GENERATE_IMAGE_TOOL_NAME = "generate_image";
export const OPENAI_CODEX_PROVIDER_ID = "openai-codex";
export const DEFAULT_IMAGE_GEN_ENDPOINT = "https://chatgpt.com/backend-api/codex";
export const GENERATED_IMAGES_DIR = "generated-images";
export const MAX_INPUT_IMAGES = 5;
/** Image generations can take minutes; match the backend's long window. */
const IMAGE_GEN_TIMEOUT_MS = 15 * 60 * 1000;

const INPUT_IMAGE_MIME_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
};

const GenerateImageParameters = Type.Object(
	{
		prompt: Type.String({
			minLength: 1,
			description: "Text description of the image to generate, or of the edit to apply when input_images are given.",
		}),
		size: Type.Optional(
			Type.String({
				pattern: "^(auto|\\d{2,5}x\\d{2,5})$",
				description: 'Output size: "auto" (default) or "WIDTHxHEIGHT", e.g. "1024x1024".',
			}),
		),
		quality: Type.Optional(
			Type.Union([Type.Literal("auto"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], {
				description: 'Rendering quality (default "auto").',
			}),
		),
		input_images: Type.Optional(
			Type.Array(Type.String(), {
				maxItems: MAX_INPUT_IMAGES,
				description: `Up to ${MAX_INPUT_IMAGES} workspace-relative image paths (png/jpeg/webp/gif) to edit or combine.`,
			}),
		),
	},
	{ additionalProperties: false },
);

export interface ImageGenActivation {
	/** Base endpoint of the Codex image backend (no trailing slash). */
	endpoint: string;
}

/**
 * Gate: the tool exists only when config opts in AND the OAuth credential is
 * present. Both reads are cheap and synchronous, so gating runs at module
 * registration (new sessions pick up config/login changes).
 */
export function resolveImageGenActivation(options?: { cwd?: string; agentDir?: string }): ImageGenActivation | undefined {
	const agentDir = options?.agentDir ?? getAgentDir();
	let configured: ReturnType<SettingsManager["getImageGen"]>;
	try {
		configured = SettingsManager.create(options?.cwd ?? process.cwd(), agentDir).getImageGen();
	} catch {
		return undefined;
	}
	// Present only when the Settings → Tools toggle is on AND an endpoint is
	// explicitly configured (Settings → General). Credentials are validated at
	// call time — an alternative endpoint may not need the Codex OAuth at all.
	if (configured?.provider !== OPENAI_CODEX_PROVIDER_ID) return undefined;
	const endpoint = configured.endpoint?.trim().replace(/\/+$/, "");
	if (!endpoint) return undefined;
	return { endpoint };
}

interface CodexImagesRuntime {
	models: MutableImagesModels;
	credentials: AuthStorage;
	model: ImagesModel<ImagesApi>;
}

function createCodexImagesRuntime(endpoint: string, agentDir: string): CodexImagesRuntime {
	const credentials = AuthStorage.create(join(agentDir, "auth.json"));
	const models = createImagesModels({ credentials });
	models.setProvider(openaiCodexImagesProvider());
	const model: ImagesModel<ImagesApi> = { ...OPENAI_CODEX_IMAGE_MODELS["gpt-image-2"], baseUrl: endpoint };
	return { models, credentials, model };
}

/** Resolve a workspace-relative input image; rejects paths escaping the cwd. */
function readInputImage(cwd: string, path: string): { data: string; mimeType: string } {
	const resolved = resolve(cwd, path);
	const relativePath = relative(resolve(cwd), resolved);
	if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
		throw new Error(`input_images must stay inside the workspace: ${path}`);
	}
	const extension = /\.[^./\\]+$/.exec(resolved)?.[0]?.toLowerCase() ?? "";
	const mimeType = INPUT_IMAGE_MIME_TYPES[extension];
	if (!mimeType) {
		throw new Error(`Unsupported input image type (expected png/jpeg/webp/gif): ${path}`);
	}
	if (!existsSync(resolved)) {
		throw new Error(`Input image not found: ${path}`);
	}
	return { data: readFileSync(resolved).toString("base64"), mimeType };
}

/** "WIDTHxHEIGHT" from a PNG IHDR header, or a byte-count fallback. */
function describeImage(buffer: Buffer): string {
	if (
		buffer.length >= 24 &&
		buffer[0] === 0x89 &&
		buffer[1] === 0x50 &&
		buffer[2] === 0x4e &&
		buffer[3] === 0x47
	) {
		const width = buffer.readUInt32BE(16);
		const height = buffer.readUInt32BE(20);
		if (width > 0 && height > 0) return `${width}x${height}`;
	}
	return `${buffer.length} bytes`;
}

function isUnauthorizedError(message: string | undefined): boolean {
	return /\bHTTP 401\b/.test(message ?? "");
}

export function registerImageGenTool(pi: ExtensionAPI, activation: ImageGenActivation): void {
	pi.registerTool({
		name: GENERATE_IMAGE_TOOL_NAME,
		label: "Generate Image",
		description:
			"Generate an image from a text prompt with OpenAI's image backend (gpt-image-2), or edit/combine up to " +
			`${MAX_INPUT_IMAGES} workspace images when input_images is given. Saves each result as a PNG under ` +
			`${GENERATED_IMAGES_DIR}/ in the workspace and returns it for inline display. Generation can take minutes.`,
		promptSnippet: "Generate or edit images from a text prompt (results land in generated-images/)",
		promptGuidelines: [
			"Use generate_image only when the user asks for an image; describe subject, style, and composition concretely in the prompt.",
			"Pass input_images (workspace-relative paths) to edit or combine existing images instead of describing them.",
		],
		parameters: GenerateImageParameters,
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const prompt = params.prompt.trim();
			if (prompt === "") {
				throw new Error("generate_image requires a non-empty prompt");
			}
			const inputImages = (params.input_images ?? []).map((path) => readInputImage(ctx.cwd, path));
			if (inputImages.length > MAX_INPUT_IMAGES) {
				throw new Error(`At most ${MAX_INPUT_IMAGES} input images are supported`);
			}

			onUpdate?.({
				content: [{ type: "text", text: inputImages.length > 0 ? "Editing image(s)..." : "Generating image..." }],
				details: { phase: "generating" },
			});

			const runtime = createCodexImagesRuntime(activation.endpoint, getAgentDir());
			const context = {
				input: [
					{ type: "text" as const, text: prompt },
					...inputImages.map((image) => ({ type: "image" as const, ...image })),
				],
			};
			const requestOptions: OpenAICodexImagesOptions = {
				size: params.size,
				quality: params.quality,
				signal,
				timeoutMs: IMAGE_GEN_TIMEOUT_MS,
			};

			let result = await runtime.models.generateImages(runtime.model, context, requestOptions);
			if (result.stopReason === "error" && isUnauthorizedError(result.errorMessage)) {
				// The access token was rejected before its recorded expiry. Force
				// one refresh through the shared credential path and retry once.
				await runtime.credentials.modify(OPENAI_CODEX_PROVIDER_ID, async (current) =>
					current?.type === "oauth" ? { ...current, expires: 0 } : undefined,
				);
				result = await runtime.models.generateImages(runtime.model, context, requestOptions);
			}

			if (result.stopReason === "aborted") {
				throw new Error("Image generation aborted");
			}
			if (result.stopReason !== "stop") {
				throw new Error(result.errorMessage ?? "Image generation failed");
			}

			const images = result.output.filter(
				(item): item is Extract<(typeof result.output)[number], { type: "image" }> => item.type === "image",
			);
			if (images.length === 0) {
				throw new Error("Image generation returned no images");
			}

			const outputDir = join(ctx.cwd, GENERATED_IMAGES_DIR);
			mkdirSync(outputDir, { recursive: true });
			const timestamp = Date.now();
			const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [];
			const files: { path: string; size: string }[] = [];
			images.forEach((image, index) => {
				const buffer = Buffer.from(image.data, "base64");
				const fileName = `img-${timestamp}-${index + 1}.png`;
				const filePath = join(outputDir, fileName);
				writeFileSync(filePath, buffer);
				const size = describeImage(buffer);
				const workspacePath = join(GENERATED_IMAGES_DIR, fileName);
				files.push({ path: workspacePath, size });
				content.push({ type: "text", text: `Generated ${workspacePath} (${size})` });
				content.push({ type: "image", data: image.data, mimeType: image.mimeType || "image/png" });
			});

			return {
				content,
				details: {
					files,
					model: result.model,
					responseId: result.responseId,
					edited: inputImages.length > 0,
				},
			};
		},
	});
}

export default function imageGenExtension(pi: ExtensionAPI): void {
	const activation = resolveImageGenActivation();
	if (!activation) return;
	registerImageGenTool(pi, activation);
}
