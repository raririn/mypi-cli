import type { Api, Model } from "./types.ts";

export interface ModelsStoreEntry {
	models: readonly Model<Api>[];
	/** Unix timestamp from the remote catalog's Last-Modified header. */
	lastModified?: number;
	/** Unix timestamp of the last completed remote check. */
	checkedAt?: number;
	/**
	 * Opaque validator from the remote catalog's ETag header, stored verbatim
	 * (quotes included) and echoed back as If-None-Match.
	 */
	etag?: string;
	/**
	 * Version of the provider's catalog→Model mapping code that produced this
	 * entry. Providers bump their version when derived fields (compat flags,
	 * thinking maps, …) change so cached entries don't outlive the code that
	 * wrote them.
	 */
	mappingVersion?: number;
}

/** Persistent model catalogs keyed by provider ID. */
export interface ModelsStore {
	read(providerId: string): Promise<ModelsStoreEntry | undefined>;
	write(providerId: string, entry: ModelsStoreEntry): Promise<void>;
	delete(providerId: string): Promise<void>;
}

/** ModelsStore scoped to one provider. Providers cannot access other providers' catalogs. */
export interface ProviderModelsStore {
	read(): Promise<ModelsStoreEntry | undefined>;
	write(entry: ModelsStoreEntry): Promise<void>;
	delete(): Promise<void>;
}

export class InMemoryModelsStore implements ModelsStore {
	private readonly entries = new Map<string, ModelsStoreEntry>();

	async read(providerId: string): Promise<ModelsStoreEntry | undefined> {
		const entry = this.entries.get(providerId);
		return entry ? structuredClone(entry) : undefined;
	}

	async write(providerId: string, entry: ModelsStoreEntry): Promise<void> {
		this.entries.set(providerId, structuredClone(entry));
	}

	async delete(providerId: string): Promise<void> {
		this.entries.delete(providerId);
	}
}
