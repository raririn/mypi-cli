import type { ImageContent } from "../types.ts";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const SUPPORTED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const DATA_URL_PATTERN = /^data:([^;,]+);base64,([\s\S]+)$/iu;

export class ImageInputError extends Error {
	readonly code = "invalid_image_input";

	constructor(message: string) {
		super(message);
		this.name = "ImageInputError";
	}
}

/**
 * Normalize one image at the provider boundary. For compatibility with GUI
 * embedders, `data` may be raw base64 or one complete base64 data URL; the
 * returned contract always contains canonical raw base64.
 */
export function normalizeImageInput(image: ImageContent): ImageContent {
	let mimeType = image.mimeType.toLowerCase().trim();
	if (mimeType === "image/jpg") mimeType = "image/jpeg";
	let data = image.data.trim();
	const dataUrl = DATA_URL_PATTERN.exec(data);
	if (dataUrl) {
		const embeddedMime = dataUrl[1]!.toLowerCase();
		if (embeddedMime === "image/jpg") mimeType = "image/jpeg";
		else if (embeddedMime !== mimeType) {
			throw new ImageInputError(`Image MIME type ${mimeType} does not match embedded data URL type ${embeddedMime}.`);
		}
		data = dataUrl[2]!;
	}
	if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
		throw new ImageInputError(`Unsupported image MIME type: ${mimeType}. Use PNG, JPEG, WEBP, or non-animated GIF.`);
	}
	const compact = data.replace(/\s+/gu, "");
	if (!compact || compact.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(compact)) {
		throw new ImageInputError("Image data is not valid base64.");
	}
	const bytes = Buffer.from(compact, "base64");
	if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
		throw new ImageInputError(`Image input must contain 1-${MAX_IMAGE_BYTES} decoded bytes.`);
	}
	if (!magicMatches(mimeType, bytes)) {
		throw new ImageInputError(`Image bytes do not match declared MIME type ${mimeType}.`);
	}
	if (mimeType === "image/gif" && bytes.includes(Buffer.from("NETSCAPE2.0", "ascii"))) {
		throw new ImageInputError("Animated GIF image inputs are not supported.");
	}
	return { type: "image", mimeType, data: bytes.toString("base64") };
}

export function imageInputDataUrl(image: ImageContent): string {
	const normalized = normalizeImageInput(image);
	return `data:${normalized.mimeType};base64,${normalized.data}`;
}

function magicMatches(mimeType: string, bytes: Buffer): boolean {
	if (mimeType === "image/png") return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
	if (mimeType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
	if (mimeType === "image/webp") return bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
	if (mimeType === "image/gif") {
		const signature = bytes.subarray(0, 6).toString("ascii");
		return signature === "GIF87a" || signature === "GIF89a";
	}
	return false;
}
