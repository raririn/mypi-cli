import { spawn } from "node:child_process";
import { JSDOM } from "jsdom";
import type { BraveResult } from "./brave.ts";

const CURL_TIMEOUT_SECONDS = 15;
const CURL_RESPONSE_LIMIT_BYTES = 2 * 1024 * 1024;

export type CredentialFreeSearchProvider = "duckduckgo" | "mojeek" | "bing";

export interface CurlTextResponse {
	body: string;
}

export interface CredentialFreeSearchResult {
	provider: CredentialFreeSearchProvider;
	results: BraveResult[];
}

export interface CredentialFreeSearchOptions {
	query: string;
	count: number;
	country: string;
	freshness?: string;
	signal?: AbortSignal;
	request?: (url: string, signal?: AbortSignal) => Promise<CurlTextResponse>;
}

interface SearchProvider {
	name: CredentialFreeSearchProvider;
	url(options: CredentialFreeSearchOptions): string;
	parse(html: string, count: number): BraveResult[];
}

function cleanText(value: string | null | undefined, maxLength: number): string {
	return (value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function safeResultUrl(value: string | null | undefined, baseUrl: string): string | undefined {
	if (!value) return undefined;
	try {
		const url = new URL(value, baseUrl);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		return url.href;
	} catch {
		return undefined;
	}
}

function decodeDuckDuckGoUrl(value: string | null | undefined): string | undefined {
	const url = safeResultUrl(value, "https://html.duckduckgo.com/");
	if (!url) return undefined;
	const parsed = new URL(url);
	if (parsed.hostname.endsWith("duckduckgo.com") && parsed.pathname === "/l/") {
		return safeResultUrl(parsed.searchParams.get("uddg"), "https://html.duckduckgo.com/");
	}
	return url;
}

function decodeBingUrl(value: string | null | undefined): string | undefined {
	const url = safeResultUrl(value, "https://www.bing.com/");
	if (!url) return undefined;
	const parsed = new URL(url);
	if (!parsed.hostname.endsWith("bing.com") || parsed.pathname !== "/ck/a") return url;
	const encoded = parsed.searchParams.get("u");
	if (!encoded?.startsWith("a1")) return url;
	try {
		const decoded = Buffer.from(encoded.slice(2), "base64url").toString("utf8");
		return safeResultUrl(decoded, "https://www.bing.com/");
	} catch {
		return url;
	}
}

function parseResults(
	html: string,
	selector: string,
	count: number,
	read: (element: Element) => BraveResult | undefined,
): BraveResult[] {
	const dom = new JSDOM(html);
	try {
		const results: BraveResult[] = [];
		const seen = new Set<string>();
		for (const element of dom.window.document.querySelectorAll(selector)) {
			const result = read(element);
			if (!result || seen.has(result.url)) continue;
			seen.add(result.url);
			results.push(result);
			if (results.length >= count) break;
		}
		return results;
	} finally {
		dom.window.close();
	}
}

function parseDuckDuckGo(html: string, count: number): BraveResult[] {
	return parseResults(html, ".result", count, (element) => {
		const anchor = element.querySelector<HTMLAnchorElement>(".result__a");
		const url = decodeDuckDuckGoUrl(anchor?.getAttribute("href"));
		if (!url) return undefined;
		return {
			title: cleanText(anchor?.textContent, 300) || url,
			url,
			snippet: cleanText(element.querySelector(".result__snippet")?.textContent, 1_200),
		};
	});
}

function parseMojeek(html: string, count: number): BraveResult[] {
	return parseResults(html, "ul.results-standard > li, .results-standard > li", count, (element) => {
		const anchor = element.querySelector<HTMLAnchorElement>("h2 a.title, h2 a");
		const url = safeResultUrl(anchor?.getAttribute("href"), "https://www.mojeek.com/");
		if (!url) return undefined;
		return {
			title: cleanText(anchor?.textContent, 300) || url,
			url,
			snippet: cleanText(element.querySelector("p.s, .s")?.textContent, 1_200),
		};
	});
}

function parseBing(html: string, count: number): BraveResult[] {
	return parseResults(html, "li.b_algo", count, (element) => {
		const anchor = element.querySelector<HTMLAnchorElement>("h2 a");
		const url = decodeBingUrl(anchor?.getAttribute("href"));
		if (!url) return undefined;
		return {
			title: cleanText(anchor?.textContent, 300) || url,
			url,
			snippet: cleanText(element.querySelector(".b_caption p")?.textContent, 1_200),
		};
	});
}

function duckDuckGoFreshness(freshness: string | undefined): string | undefined {
	return freshness === "pd"
		? "d"
		: freshness === "pw"
			? "w"
			: freshness === "pm"
				? "m"
				: freshness === "py"
					? "y"
					: undefined;
}

const PROVIDERS: readonly SearchProvider[] = [
	{
		name: "duckduckgo",
		url(options) {
			const params = new URLSearchParams({ q: options.query });
			const freshness = duckDuckGoFreshness(options.freshness);
			if (freshness) params.set("df", freshness);
			return `https://html.duckduckgo.com/html/?${params}`;
		},
		parse: parseDuckDuckGo,
	},
	{
		name: "mojeek",
		url(options) {
			return `https://www.mojeek.com/search?${new URLSearchParams({ q: options.query })}`;
		},
		parse: parseMojeek,
	},
	{
		name: "bing",
		url(options) {
			const params = new URLSearchParams({ q: options.query, count: String(options.count) });
			return `https://www.bing.com/search?${params}`;
		},
		parse: parseBing,
	},
];

export function requestWithCurl(url: string, signal?: AbortSignal): Promise<CurlTextResponse> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason instanceof Error ? signal.reason : new Error("Web search was cancelled."));
			return;
		}

		const child = spawn(
			"curl",
			[
				"--silent",
				"--show-error",
				"--fail-with-body",
				"--location",
				"--max-time",
				String(CURL_TIMEOUT_SECONDS),
				"--connect-timeout",
				"5",
				"--max-filesize",
				String(CURL_RESPONSE_LIMIT_BYTES),
				"--proto",
				"=https",
				"--proto-redir",
				"=https",
				"--header",
				"Accept: text/html,application/xhtml+xml",
				"--header",
				"Accept-Language: en-US,en;q=0.8",
				"--user-agent",
				"Mozilla/5.0 (compatible; MyPi-WebSearch/0.1)",
				"--url",
				url,
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);

		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let stdoutBytes = 0;
		let settled = false;

		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", abort);
			if (error) reject(error);
			else resolve({ body: Buffer.concat(stdout).toString("utf8") });
		};
		const abort = () => {
			child.kill("SIGTERM");
			finish(signal?.reason instanceof Error ? signal.reason : new Error("Web search was cancelled."));
		};
		signal?.addEventListener("abort", abort, { once: true });

		child.stdout.on("data", (chunk: Buffer) => {
			stdoutBytes += chunk.length;
			if (stdoutBytes > CURL_RESPONSE_LIMIT_BYTES) {
				child.kill("SIGTERM");
				finish(new Error(`Search response exceeded ${CURL_RESPONSE_LIMIT_BYTES} bytes.`));
				return;
			}
			stdout.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (Buffer.concat(stderr).length < 4_096) stderr.push(chunk);
		});
		child.on("error", (error) => finish(new Error(`Could not start curl: ${error.message}`)));
		child.on("close", (code) => {
			if (settled) return;
			if (code === 0) {
				finish();
				return;
			}
			const detail = cleanText(Buffer.concat(stderr).toString("utf8"), 500);
			finish(new Error(`curl exited with status ${code ?? "unknown"}${detail ? `: ${detail}` : ""}`));
		});
	});
}

export async function searchCredentialFree(options: CredentialFreeSearchOptions): Promise<CredentialFreeSearchResult> {
	const query = options.query.trim();
	if (!query) throw new Error("Search query must not be empty.");
	const count = Math.max(1, Math.min(20, Math.trunc(options.count)));
	const request = options.request ?? requestWithCurl;
	const failures: string[] = [];

	for (const provider of PROVIDERS) {
		try {
			const response = await request(provider.url({ ...options, query, count }), options.signal);
			const results = provider.parse(response.body, count);
			if (results.length > 0) return { provider: provider.name, results };
			failures.push(`${provider.name}: no parseable results`);
		} catch (error) {
			if (options.signal?.aborted) throw error;
			failures.push(`${provider.name}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	throw new Error(`Credential-free web search failed (${failures.join("; ")}).`);
}
