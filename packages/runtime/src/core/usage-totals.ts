import type { Usage } from "@earendil-works/pi-ai/compat";
import type { SessionEntry } from "./session-manager.ts";

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export function createUsageTotals(): UsageTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
	};
}

export function addUsageToTotals(totals: UsageTotals, usage: Usage): void {
	totals.input += usage.input;
	totals.output += usage.output;
	totals.cacheRead += usage.cacheRead;
	totals.cacheWrite += usage.cacheWrite;
	totals.cost += usage.cost.total;
}

/** Read program-owned structured-finalizer usage without trusting arbitrary custom entry data. */
export function getStructuredOutputUsage(entry: SessionEntry): Usage | undefined {
	if (entry.type !== "custom" || entry.customType !== "mypi-structured-output") return undefined;
	const data = entry.data;
	if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
	const record = data as Record<string, unknown>;
	if (record.version !== 1 || record.kind !== "result") return undefined;
	const usage = record.usage;
	if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
	const candidate = usage as Partial<Usage>;
	if (
		![candidate.input, candidate.output, candidate.cacheRead, candidate.cacheWrite].every(
			(value) => typeof value === "number" && Number.isFinite(value),
		) ||
		!candidate.cost ||
		typeof candidate.cost.total !== "number" ||
		!Number.isFinite(candidate.cost.total)
	) {
		return undefined;
	}
	return candidate as Usage;
}

/** Read program-owned subagent grant usage without trusting arbitrary custom entry data. */
export function getSubagentGrantUsage(entry: SessionEntry): Usage | undefined {
	if (entry.type !== "custom" || entry.customType !== "mypi-subagent-usage") return undefined;
	const data = entry.data;
	if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
	const record = data as Record<string, unknown>;
	if (record.version !== 1) return undefined;
	const usage = record.usage;
	if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
	const candidate = usage as Record<string, unknown>;
	const numbers = [candidate.input, candidate.output, candidate.cacheRead, candidate.cacheWrite, candidate.cost];
	if (!numbers.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)) return undefined;
	return {
		input: candidate.input as number,
		output: candidate.output as number,
		cacheRead: candidate.cacheRead as number,
		cacheWrite: candidate.cacheWrite as number,
		totalTokens: typeof candidate.total === "number" && Number.isFinite(candidate.total)
			? candidate.total as number
			: (candidate.input as number) + (candidate.output as number) + (candidate.cacheRead as number) + (candidate.cacheWrite as number),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: candidate.cost as number },
	};
}

export interface UsageCostBreakdownEntry {
	key: string;
	cost: number;
	tokens: number;
}

/** Group attributable assistant usage by model and all other usage into a separate bucket. */
export function getUsageCostBreakdown(entries: SessionEntry[]): UsageCostBreakdownEntry[] {
	const totalsByKey = new Map<string, UsageTotals>();

	for (const entry of entries) {
		let key: string | undefined;
		let usage: Usage | undefined;
		const structuredUsage = getStructuredOutputUsage(entry);
		if (entry.type === "message" && entry.message.role === "assistant") {
			key = `${entry.message.provider}/${entry.message.responseModel ?? entry.message.model}`;
			usage = entry.message.usage;
		} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
			key = "Tools/summaries";
			usage = entry.message.usage;
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			key = "Tools/summaries";
			usage = entry.usage;
		} else if (structuredUsage) {
			key = "Structured finalization";
			usage = structuredUsage;
		} else {
			const subagentUsage = getSubagentGrantUsage(entry);
			if (subagentUsage) {
				key = "Subagents";
				usage = subagentUsage;
			}
		}
		if (!key || !usage) continue;

		let totals = totalsByKey.get(key);
		if (!totals) {
			totals = createUsageTotals();
			totalsByKey.set(key, totals);
		}
		addUsageToTotals(totals, usage);
	}

	return Array.from(totalsByKey, ([key, totals]) => ({
		key,
		cost: totals.cost,
		tokens: totals.input + totals.output + totals.cacheRead + totals.cacheWrite,
	}))
		.filter((entry) => entry.cost > 0 || entry.tokens > 0)
		.sort((a, b) => b.cost - a.cost);
}
