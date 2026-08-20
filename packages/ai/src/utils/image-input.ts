import type { ImageContent } from "../types.ts";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_COUNT = 20;
const MAX_TOTAL_IMAGE_BYTES = 50 * 1024 * 1024;
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
	let bytes: Uint8Array;
	try {
		const binary = atob(compact.padEnd(Math.ceil(compact.length / 4) * 4, "="));
		bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
	} catch {
		throw new ImageInputError("Image data is not valid base64.");
	}
	if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
		throw new ImageInputError(`Image input must contain 1-${MAX_IMAGE_BYTES} decoded bytes.`);
	}
	if (!magicMatches(mimeType, bytes)) {
		throw new ImageInputError(`Image bytes do not match declared MIME type ${mimeType}.`);
	}
	if (mimeType === "image/gif" && containsAscii(bytes, "NETSCAPE2.0")) {
		throw new ImageInputError("Animated GIF image inputs are not supported.");
	}
	return { type: "image", mimeType, data: encodeBase64(bytes) };
}

export function imageInputDataUrl(image: ImageContent): string {
	const normalized = normalizeImageInput(image);
	return `data:${normalized.mimeType};base64,${normalized.data}`;
}

export function normalizeImageInputs(images: readonly ImageContent[]): ImageContent[] {
	if (images.length > MAX_IMAGE_COUNT) {
		throw new ImageInputError(`A request may contain at most ${MAX_IMAGE_COUNT} images.`);
	}
	const normalized = images.map(normalizeImageInput);
	const totalBytes = normalized.reduce((total, image) => {
		const padding = image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0;
		return total + Math.floor((image.data.length * 3) / 4) - padding;
	}, 0);
	if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
		throw new ImageInputError(`Combined image input exceeds ${MAX_TOTAL_IMAGE_BYTES} decoded bytes.`);
	}
	return normalized;
}

function magicMatches(mimeType: string, bytes: Uint8Array): boolean {
	if (mimeType === "image/png") return startsWith(bytes, [137, 80, 78, 71, 13, 10, 26, 10]);
	if (mimeType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
	if (mimeType === "image/webp") return startsWith(bytes, [82, 73, 70, 70]) && startsWith(bytes.subarray(8), [87, 69, 66, 80]);
	if (mimeType === "image/gif") {
		return startsWith(bytes, [71, 73, 70, 56, 55, 97]) || startsWith(bytes, [71, 73, 70, 56, 57, 97]);
	}
	return false;
}

function startsWith(bytes: Uint8Array, expected: ArrayLike<number>): boolean {
	if (bytes.length < expected.length) return false;
	for (let index = 0; index < expected.length; index++) {
		if (bytes[index] !== expected[index]) return false;
	}
	return true;
}

function containsAscii(bytes: Uint8Array, value: string): boolean {
	const expected = Uint8Array.from(value, (character) => character.charCodeAt(0));
	for (let index = 0; index <= bytes.length - expected.length; index++) {
		if (startsWith(bytes.subarray(index), expected)) return true;
	}
	return false;
}

function encodeBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	}
	return btoa(binary);
}
