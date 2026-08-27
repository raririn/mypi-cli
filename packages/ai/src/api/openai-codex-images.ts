/**
 * OpenAI Codex image generation (ChatGPT Plus/Pro OAuth).
 *
 * Plain JSON, non-streaming POST against the ChatGPT Codex image backend:
 *
 *   POST {baseUrl}/images/generations   — text prompt only
 *   POST {baseUrl}/images/edits         — prompt plus up to 5 input images
 *
 * The default baseUrl is https://chatgpt.com/backend-api/codex. Auth is the
 * stored `openai-codex` OAuth access token (options.apiKey after
 * resolveProviderAuth); the chatgpt-account-id header is extracted from the
 * token's JWT claim. Requests intentionally send NO OpenAI-Beta header.
 *
 * Error semantics: 429 / usage-limit codes produce a friendly subscription
 * message (never retried); 403/404 report plan unavailability; transient 5xx
 * responses are retried once. 401 responses surface as "HTTP 401" so callers
 * holding the credential store can force a token refresh and retry.
 */
import type * as NodeOs from "node:os";
import type {
	AssistantImages,
	ImageContent,
	ImagesContext,
	ImagesFunction,
	ImagesModel,
	ImagesOptions,
	ProviderHeaders,
} from "../types.ts";
import { combineAbortSignals } from "../utils/abort-signals.ts";

type ProcessWithOsBuiltinModule = typeof process & {
	getBuiltinModule?: (id: "node:os") => typeof NodeOs;
};

function loadNodeOs(): typeof NodeOs | null {
	if (typeof process === "undefined" || !(process.versions?.node || process.versions?.bun)) {
		return null;
	}
	return (process as ProcessWithOsBuiltinModule).getBuiltinModule?.("node:os") ?? null;
}

// NEVER convert to top-level runtime imports - breaks browser/Vite builds
const _os: typeof NodeOs | null = loadNodeOs();

const JWT_CLAIM_PATH = "https://api.openai.com/auth" as const;
export const OPENAI_CODEX_IMAGES_DEFAULT_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const OPENAI_CODEX_IMAGES_REQUEST_ID_HEADER = "x-codex-imagegen-request-id";
/** Image generations can be slow; the backend allows very long requests. */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
export const MAX_INPUT_IMAGES = 5;

export interface OpenAICodexImagesOptions extends ImagesOptions {
	/** "auto" (default) or "WIDTHxHEIGHT", e.g. "1024x1024". */
	size?: string;
	quality?: "auto" | "low" | "medium" | "high";
	/** Background handling; the backend default is "auto". */
	background?: string;
}

interface CodexImagesResponse {
	created?: number;
	data?: { b64_json?: string }[];
	size?: string;
	usage?: unknown;
}

interface CodexImagesErrorBody {
	error?: {
		code?: string;
		type?: string;
		message?: string;
		plan_type?: string;
		resets_at?: number;
		limit_id?: string;
	};
}

export const generateImages: ImagesFunction<"openai-codex-images", OpenAICodexImagesOptions> = async (
	model: ImagesModel<"openai-codex-images">,
	context: ImagesContext,
	options?: OpenAICodexImagesOptions,
) => {
	const output: AssistantImages = {
		api: model.api,
		provider: model.provider,
		model: model.id,
		output: [],
		stopReason: "stop",
		timestamp: Date.now(),
	};

	const combined = combineAbortSignals([
		options?.signal,
		AbortSignal.timeout(options?.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS),
	]);

	try {
		const token = options?.apiKey;
		if (!token) {
			throw new Error(`No OAuth access token for provider: ${model.provider}`);
		}
		const accountId = extractAccountId(token);
		const inputImages = collectInputImages(context);
		const url = `${model.baseUrl.replace(/\/+$/, "")}/images/${inputImages.length > 0 ? "edits" : "generations"}`;

		let payload: Record<string, unknown> = {
			prompt: collectPrompt(context),
			model: model.id,
			background: options?.background ?? "auto",
			quality: options?.quality ?? "auto",
			size: options?.size ?? "auto",
			...(inputImages.length > 0
				? { images: inputImages.map((image) => ({ image_url: `data:${image.mimeType};base64,${image.data}` })) }
				: {}),
		};
		const nextPayload = await options?.onPayload?.(payload, model);
		if (nextPayload !== undefined) {
			payload = nextPayload as typeof payload;
		}

		const headers = buildImageHeaders(model.headers, options?.headers, accountId, token);
		const request = () =>
			fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify(payload),
				signal: combined.signal,
			});

		let response = await request();
		if (response.status >= 500 && response.status < 600) {
			// One retry for transient upstream failures. 429s are never retried
			// blindly: they carry the user's subscription limit.
			response = await request();
		}

		await options?.onResponse?.(
			{ status: response.status, headers: Object.fromEntries(response.headers.entries()) },
			model,
		);

		if (!response.ok) {
			const { message, friendlyMessage } = await parseErrorResponse(response);
			throw new Error(friendlyMessage ?? message);
		}

		const requestId = response.headers.get(OPENAI_CODEX_IMAGES_REQUEST_ID_HEADER);
		if (requestId) output.responseId = requestId;

		const body = (await response.json()) as CodexImagesResponse;
		for (const entry of body.data ?? []) {
			if (!entry.b64_json) continue;
			output.output.push({
				type: "image",
				data: entry.b64_json,
				mimeType: "image/png",
			} satisfies ImageContent);
		}
		if (output.output.length === 0) {
			throw new Error("Image generation returned no images");
		}

		return output;
	} catch (error) {
		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		output.errorMessage = error instanceof Error ? error.message : String(error);
		return output;
	} finally {
		combined.cleanup();
	}
};

function collectPrompt(context: ImagesContext): string {
	return context.input
		.filter((item): item is Extract<typeof item, { type: "text" }> => item.type === "text")
		.map((item) => item.text)
		.join("\n")
		.trim();
}

function collectInputImages(context: ImagesContext): ImageContent[] {
	const images = context.input.filter((item): item is ImageContent => item.type === "image");
	if (images.length > MAX_INPUT_IMAGES) {
		throw new Error(`At most ${MAX_INPUT_IMAGES} input images are supported`);
	}
	return images;
}

function extractAccountId(token: string): string {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) throw new Error("Invalid token");
		const payload = JSON.parse(atob(parts[1])) as Record<string, { chatgpt_account_id?: string } | undefined>;
		const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
		if (!accountId) throw new Error("No account ID in token");
		return accountId;
	} catch {
		throw new Error("Failed to extract accountId from token");
	}
}

function buildImageHeaders(
	modelHeaders: Record<string, string> | undefined,
	additionalHeaders: ProviderHeaders | undefined,
	accountId: string,
	token: string,
): Headers {
	const headers = new Headers(modelHeaders);
	for (const [key, value] of Object.entries(additionalHeaders || {})) {
		if (value === null) {
			headers.delete(key);
		} else {
			headers.set(key, value);
		}
	}
	headers.set("Authorization", `Bearer ${token}`);
	headers.set("chatgpt-account-id", accountId);
	headers.set("originator", "pi");
	const userAgent = _os ? `pi (${_os.platform()} ${_os.release()}; ${_os.arch()})` : "pi (browser)";
	headers.set("User-Agent", userAgent);
	headers.set("content-type", "application/json");
	headers.set("accept", "application/json");
	// Deliberately no OpenAI-Beta header: the imagegen endpoint rejects it.
	headers.delete("OpenAI-Beta");
	return headers;
}

async function parseErrorResponse(response: Response): Promise<{ message: string; friendlyMessage?: string }> {
	const raw = await response.text();
	let message = `HTTP ${response.status}: ${raw || response.statusText || "Request failed"}`;
	let friendlyMessage: string | undefined;

	try {
		const parsed = JSON.parse(raw) as CodexImagesErrorBody;
		const err = parsed?.error;
		if (err) {
			const code = err.code || err.type || "";
			if (/usage_limit_reached|usage_not_included|rate_limit_exceeded/i.test(code) || response.status === 429) {
				const plan = err.plan_type ? ` (${err.plan_type.toLowerCase()} plan)` : "";
				const mins = err.resets_at
					? Math.max(0, Math.round((err.resets_at * 1000 - Date.now()) / 60000))
					: undefined;
				const when = mins !== undefined ? ` Try again in ~${mins} min.` : "";
				friendlyMessage = `You have hit your ChatGPT image generation limit${plan}.${when}`.trim();
			} else if (response.status === 403 || response.status === 404) {
				friendlyMessage = "Image generation is not available on this ChatGPT plan or account.";
			}
			if (err.message) message = `HTTP ${response.status}: ${err.message}`;
		}
	} catch {
		if (response.status === 403 || response.status === 404) {
			friendlyMessage = "Image generation is not available on this ChatGPT plan or account.";
		}
	}

	return { message, friendlyMessage };
}
