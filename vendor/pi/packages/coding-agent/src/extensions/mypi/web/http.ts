import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";

/** Shared network bounds for built-in public web reads. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
export const DEFAULT_RESPONSE_LIMIT_BYTES = 2 * 1024 * 1024;

export interface TextResponse {
	url: string;
	status: number;
	headers: Record<string, string | string[] | undefined>;
	body: string;
}

export interface RequestTextOptions {
	signal?: AbortSignal;
	headers?: Record<string, string>;
	timeoutMs?: number;
	maxBytes?: number;
	maxRedirects?: number;
}

function normalizeHostname(hostname: string): string {
	return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

export function isPublicIpAddress(address: string): boolean {
	try {
		const parsed = ipaddr.parse(address);
		if (parsed.kind() === "ipv6" && parsed.range() === "ipv4Mapped") {
			return (parsed as ipaddr.IPv6).toIPv4Address().range() === "unicast";
		}
		return parsed.range() === "unicast";
	} catch {
		return false;
	}
}

export function validatePublicHttpUrl(input: string | URL): URL {
	const url = input instanceof URL ? new URL(input.href) : new URL(input);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`Unsupported URL protocol: ${url.protocol || "(none)"}`);
	}
	if (url.username || url.password) {
		throw new Error("URLs containing credentials are not allowed.");
	}

	const hostname = normalizeHostname(url.hostname).toLowerCase();
	if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
		throw new Error(`Private or local hostname is not allowed: ${hostname || "(empty)"}`);
	}
	if (isIP(hostname) && !isPublicIpAddress(hostname)) {
		throw new Error(`Private, reserved, or local IP address is not allowed: ${hostname}`);
	}
	return url;
}

const publicLookup: LookupFunction = ((hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
	const normalizedOptions =
		typeof options === "number"
			? { family: options, all: false }
			: ((options as { family?: number; all?: boolean } | undefined) ?? {});

	void dnsLookup(normalizeHostname(hostname), {
		all: true,
		verbatim: true,
		family: normalizedOptions.family === 4 || normalizedOptions.family === 6 ? normalizedOptions.family : 0,
	})
		.then((addresses) => {
			if (addresses.length === 0) throw new Error(`No addresses found for ${hostname}`);
			const unsafe = addresses.find((entry) => !isPublicIpAddress(entry.address));
			if (unsafe) throw new Error(`Refusing non-public address for ${hostname}: ${unsafe.address}`);
			if (normalizedOptions.all) callback(null, addresses);
			else callback(null, addresses[0]!.address, addresses[0]!.family);
		})
		.catch((error: unknown) => {
			callback(error instanceof Error ? error : new Error(String(error)));
		});
}) as LookupFunction;

function requestOnce(
	url: URL,
	options: Required<Pick<RequestTextOptions, "timeoutMs" | "maxBytes">> & RequestTextOptions,
): Promise<TextResponse> {
	const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
	const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
	const request = url.protocol === "https:" ? httpsRequest : httpRequest;

	return new Promise<TextResponse>((resolve, reject) => {
		const req = request(
			url,
			{
				method: "GET",
				headers: options.headers,
				lookup: publicLookup,
				signal,
			},
			(response) => {
				const status = response.statusCode ?? 0;
				const headers = response.headers;
				if (status >= 300 && status < 400 && headers.location) {
					response.resume();
					resolve({ url: url.href, status, headers, body: "" });
					return;
				}

				const declaredLength = Number(headers["content-length"] ?? 0);
				if (Number.isFinite(declaredLength) && declaredLength > options.maxBytes) {
					response.destroy();
					reject(new Error(`Response exceeded ${options.maxBytes} bytes.`));
					return;
				}

				const chunks: Buffer[] = [];
				let total = 0;
				response.on("data", (chunk: Buffer | string) => {
					const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
					total += buffer.length;
					if (total > options.maxBytes) {
						response.destroy(new Error(`Response exceeded ${options.maxBytes} bytes.`));
						return;
					}
					chunks.push(buffer);
				});
				response.on("end", () => {
					resolve({ url: url.href, status, headers, body: Buffer.concat(chunks).toString("utf8") });
				});
				response.on("error", reject);
			},
		);
		req.on("error", (error) => {
			if (timeoutSignal.aborted && !options.signal?.aborted) {
				reject(new Error(`Request timed out after ${options.timeoutMs}ms.`));
				return;
			}
			reject(error);
		});
		req.end();
	});
}

export async function requestText(input: string | URL, options: RequestTextOptions = {}): Promise<TextResponse> {
	let url = validatePublicHttpUrl(input);
	const maxRedirects = options.maxRedirects ?? 5;
	const normalizedOptions = {
		...options,
		timeoutMs: options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
		maxBytes: options.maxBytes ?? DEFAULT_RESPONSE_LIMIT_BYTES,
	};

	for (let redirects = 0; ; redirects += 1) {
		const response = await requestOnce(url, normalizedOptions);
		const location = response.headers.location;
		if (response.status < 300 || response.status >= 400 || !location) return response;
		if (redirects >= maxRedirects) throw new Error(`Too many redirects while fetching ${input}.`);
		url = validatePublicHttpUrl(new URL(Array.isArray(location) ? location[0]! : location, url));
	}
}
