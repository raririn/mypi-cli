/**
 * MCP-to-Pi content conversion: untrusted framing, hard bounds, credential
 * redaction, and typed omitted-content metadata (docs/31 section 8).
 */

import { MCP_LIMITS } from "./types.ts";
import type { RawMcpContent } from "./connection.ts";

export interface McpTextPart {
	readonly type: "text";
	readonly text: string;
}

export interface McpImagePart {
	readonly type: "image";
	readonly data: string;
	readonly mimeType: string;
}

export interface McpOmittedPart {
	readonly type: string;
	readonly reason: string;
}

export interface ConvertedMcpResult {
	readonly content: ReadonlyArray<McpTextPart | McpImagePart>;
	readonly isError: boolean;
	readonly omitted: readonly McpOmittedPart[];
}

const IMAGE_MIME_ALLOWLIST = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export function untrustedFrame(serverId: string, remoteName: string): string {
	return `[Untrusted MCP content: ${serverId}/${remoteName}]`;
}

export function redactMcpText(value: string): string {
	return value
		.replace(/(authorization\s*[:=]\s*)\S+/giu, "$1[REDACTED]")
		.replace(/\b(?:sk|rk|pk|ghp|gho|xox[baprs])-[A-Za-z0-9_-]{16,}\b/gu, "[REDACTED]")
		.replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/gu, "[REDACTED PRIVATE KEY]");
}

/** Convert a tools/call result. The first text part carries the untrusted frame. */
export function convertCallResult(
	serverId: string,
	remoteName: string,
	rawContent: readonly RawMcpContent[],
	isError: boolean,
): ConvertedMcpResult {
	const content: Array<McpTextPart | McpImagePart> = [];
	const omitted: McpOmittedPart[] = [];
	let textBudget = MCP_LIMITS.maxResultTextBytes;
	let imageCount = 0;
	let imageBudget = MCP_LIMITS.maxCombinedImageBytes;

	const pushText = (raw: string) => {
		if (textBudget <= 0) {
			omitted.push({ type: "text", reason: "model-visible text budget exhausted" });
			return;
		}
		const redacted = redactMcpText(raw);
		const bounded = boundUtf8(redacted, textBudget);
		textBudget -= Buffer.byteLength(bounded, "utf8");
		content.push({ type: "text", text: bounded });
	};

	for (const part of rawContent) {
		if (content.length >= MCP_LIMITS.maxContentBlocks) {
			omitted.push({ type: part.type, reason: `content block limit ${MCP_LIMITS.maxContentBlocks} reached` });
			continue;
		}
		if (part.type === "text" && typeof part.text === "string") {
			pushText(part.text);
			continue;
		}
		if (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
			if (!IMAGE_MIME_ALLOWLIST.has(part.mimeType)) {
				omitted.push({ type: "image", reason: `image MIME is not allowlisted: ${part.mimeType}` });
				continue;
			}
			const bytes = Math.floor(part.data.length * 0.75);
			if (imageCount >= MCP_LIMITS.maxImages || bytes > MCP_LIMITS.maxImageBytes || bytes > imageBudget) {
				omitted.push({ type: "image", reason: "image count or size budget exceeded" });
				continue;
			}
			imageCount += 1;
			imageBudget -= bytes;
			content.push({ type: "image", data: part.data, mimeType: part.mimeType });
			continue;
		}
		if (part.type === "resource" && part.resource && typeof part.resource === "object") {
			// Embedded text resources become framed text; blobs are omitted metadata.
			const resource = part.resource as Record<string, unknown>;
			if (typeof resource.text === "string") {
				const uri = typeof resource.uri === "string" ? resource.uri : "(unknown uri)";
				pushText(`[Embedded MCP resource: ${uri}]\n${resource.text}`);
				continue;
			}
			omitted.push({ type: "resource", reason: "binary embedded resources are not model-visible in Slice A" });
			continue;
		}
		if (part.type === "resource_link") {
			// Resource links are never followed automatically (docs/31 sec. 4).
			const uri = typeof part.uri === "string" ? part.uri : "(unknown uri)";
			pushText(`[MCP resource link (not followed): ${uri}]`);
			continue;
		}
		omitted.push({ type: part.type, reason: "audio, blobs, and unknown content types are not model-visible in Slice A" });
	}

	const frame: McpTextPart = { type: "text", text: untrustedFrame(serverId, remoteName) };
	return { content: [frame, ...content], isError, omitted };
}

function boundUtf8(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	const buffer = Buffer.from(value, "utf8").subarray(0, Math.max(0, maxBytes - 24));
	return `${buffer.toString("utf8").replace(/\uFFFD+$/u, "")}\n[truncated by MyPi]`;
}
