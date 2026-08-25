/**
 * Transcript write hygiene for extension custom entries.
 *
 * Snapshot-kind entries are last-writer-wins on restore, so an append only
 * matters when the significant content changed — or enough time passed that
 * refreshing volatile fields (timestamps, counters) keeps crash-recovery
 * staleness bounded. Event-kind entries always append, but a flood guard
 * flags features that write one customType at bloat-producing rates.
 */
import type { AppendEntryOptions } from "./types.ts";

export const DEFAULT_SNAPSHOT_INTERVAL_MS = 30_000;
const FLOOD_WINDOW_MS = 60_000;
const FLOOD_COUNT_LIMIT = 60;
const FLOOD_BYTE_LIMIT = 512 * 1024;

export interface SnapshotGate {
	shouldPersist(customType: string, data: unknown, options: AppendEntryOptions, now?: number): boolean;
}

export function createSnapshotGate(): SnapshotGate {
	const state = new Map<string, { key: string; at: number }>();
	return {
		shouldPersist(customType, data, options, now = Date.now()) {
			const volatileKeys = new Set(options.volatileKeys ?? []);
			let significant: unknown = data;
			if (volatileKeys.size > 0 && data !== null && typeof data === "object" && !Array.isArray(data)) {
				significant = Object.fromEntries(
					Object.entries(data as Record<string, unknown>).filter(([key]) => !volatileKeys.has(key)),
				);
			}
			let key: string;
			try {
				key = JSON.stringify(significant) ?? "";
			} catch {
				return true; // Unserializable content: never suppress the write.
			}
			const previous = state.get(customType);
			const minInterval = options.minIntervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS;
			if (previous && previous.key === key && now - previous.at < minInterval) return false;
			state.set(customType, { key, at: now });
			return true;
		},
	};
}

export interface FloodGuard {
	/** Records one append; invokes `warn` the first time a customType crosses
	 *  the rate/volume limit inside a rolling window. Never blocks writes. */
	record(customType: string, data: unknown, warn: (message: string) => void, now?: number): void;
}

export function createFloodGuard(): FloodGuard {
	const windows = new Map<string, { windowStart: number; count: number; bytes: number; warned: boolean }>();
	return {
		record(customType, data, warn, now = Date.now()) {
			let bytes = 0;
			try {
				bytes = JSON.stringify(data)?.length ?? 0;
			} catch {
				bytes = 0;
			}
			const window = windows.get(customType);
			if (!window || now - window.windowStart > FLOOD_WINDOW_MS) {
				windows.set(customType, { windowStart: now, count: 1, bytes, warned: false });
				return;
			}
			window.count += 1;
			window.bytes += bytes;
			if (!window.warned && (window.count > FLOOD_COUNT_LIMIT || window.bytes > FLOOD_BYTE_LIMIT)) {
				window.warned = true;
				warn(
					`[transcript-guardrail] custom entry "${customType}" wrote ${window.count} entries / ${window.bytes} bytes in under a minute — ` +
						`if this is state (not events), declare it with appendEntry(..., { kind: "snapshot" }).`,
				);
			}
		},
	};
}
