import { type BraveResult, searchBrave } from "./brave.ts";
import { resolveBraveSearchConfig, resolveWebSearchPreference, type WebSearchProviderPreference } from "./config.ts";
import {
	type CredentialFreeSearchOptions,
	type CredentialFreeSearchProvider,
	type CredentialFreeSearchResult,
	searchCredentialFree,
} from "./curl-search.ts";

export interface WebSearchOptions {
	agentDir: string;
	query: string;
	count: number;
	country?: string;
	freshness?: string;
	signal?: AbortSignal;
	braveSearch?: typeof searchBrave;
	credentialFreeSearch?: (options: CredentialFreeSearchOptions) => Promise<CredentialFreeSearchResult>;
}

export interface WebSearchResult {
	provider: "brave" | CredentialFreeSearchProvider;
	requestedProvider: WebSearchProviderPreference;
	results: BraveResult[];
	braveFallback: boolean;
}

/** Apply the host preference, with Brave always failing over to credential-free curl providers. */
export async function searchWeb(options: WebSearchOptions): Promise<WebSearchResult> {
	const requestedProvider = resolveWebSearchPreference(options.agentDir).provider;
	const config = requestedProvider === "brave" ? resolveBraveSearchConfig(options.agentDir) : undefined;
	const count = Math.max(1, Math.min(20, Math.trunc(options.count)));
	const country = options.country ?? config?.defaultCountry ?? "US";
	const fallbackSearch = options.credentialFreeSearch ?? searchCredentialFree;

	if (config) {
		try {
			const results = await (options.braveSearch ?? searchBrave)({
				apiKey: config.apiKey,
				query: options.query,
				count,
				country,
				freshness: options.freshness,
				signal: options.signal,
			});
			if (results.length > 0) {
				return { provider: "brave", requestedProvider, results, braveFallback: false };
			}
		} catch (error) {
			if (options.signal?.aborted) throw error;
		}
	}

	const fallback = await fallbackSearch({
		query: options.query,
		count,
		country,
		freshness: options.freshness,
		signal: options.signal,
	});
	return {
		provider: fallback.provider,
		requestedProvider,
		results: fallback.results,
		braveFallback: requestedProvider === "brave",
	};
}
