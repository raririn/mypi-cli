import { requestText } from "./http.ts";

/** Structured result shape shared by API and credential-free providers. */
const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const FRESHNESS_PATTERN = /^(?:pd|pw|pm|py|\d{4}-\d{2}-\d{2}to\d{4}-\d{2}-\d{2})$/;

export interface BraveResult {
	title: string;
	url: string;
	snippet: string;
	age?: string;
}

export interface BraveSearchOptions {
	apiKey: string;
	query: string;
	count: number;
	country: string;
	freshness?: string;
	signal?: AbortSignal;
	request?: typeof requestText;
}

function cleanText(value: unknown, maxLength: number): string {
	if (typeof value !== "string") return "";
	return value
		.replace(/<[^>]*>/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, maxLength);
}

export async function searchBrave(options: BraveSearchOptions): Promise<BraveResult[]> {
	const query = options.query.trim();
	if (!query) throw new Error("Search query must not be empty.");
	const count = Math.max(1, Math.min(20, Math.trunc(options.count)));
	const country = options.country.trim().toUpperCase();
	if (!/^[A-Z]{2}$/.test(country)) throw new Error("Country must be a two-letter code.");
	if (options.freshness && !FRESHNESS_PATTERN.test(options.freshness)) {
		throw new Error("Freshness must be pd, pw, pm, py, or YYYY-MM-DDtoYYYY-MM-DD.");
	}

	const params = new URLSearchParams({ q: query, count: String(count), country });
	if (options.freshness) params.set("freshness", options.freshness);
	const request = options.request ?? requestText;
	const response = await request(`${BRAVE_SEARCH_ENDPOINT}?${params}`, {
		signal: options.signal,
		timeoutMs: 15_000,
		maxBytes: 2 * 1024 * 1024,
		maxRedirects: 0,
		headers: {
			Accept: "application/json",
			"Accept-Encoding": "identity",
			"X-Subscription-Token": options.apiKey,
		},
	});
	if (response.status < 200 || response.status >= 300) {
		const detail = cleanText(response.body, 500).replaceAll(options.apiKey, "[redacted]");
		throw new Error(`Brave Search returned HTTP ${response.status}${detail ? `: ${detail}` : "."}`);
	}

	let data: unknown;
	try {
		data = JSON.parse(response.body);
	} catch {
		throw new Error("Brave Search returned invalid JSON.");
	}
	const webResults = (data as { web?: { results?: unknown[] } })?.web?.results;
	if (!Array.isArray(webResults)) return [];

	return webResults.slice(0, count).flatMap((value) => {
		if (!value || typeof value !== "object") return [];
		const result = value as {
			title?: unknown;
			url?: unknown;
			description?: unknown;
			age?: unknown;
			page_age?: unknown;
		};
		const url = cleanText(result.url, 2_048);
		try {
			const parsed = new URL(url);
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return [];
		} catch {
			return [];
		}
		return [
			{
				title: cleanText(result.title, 300) || url,
				url,
				snippet: cleanText(result.description, 1_200),
				age: cleanText(result.age ?? result.page_age, 100) || undefined,
			},
		];
	});
}
