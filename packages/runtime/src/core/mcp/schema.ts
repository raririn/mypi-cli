/**
 * JSON Schema bounds/normalization, exposed-name generation, and catalog
 * fingerprints (docs/31 sections 4 and 8).
 */

import { createHash } from "node:crypto";
import { MCP_LIMITS } from "./types.ts";

export interface SchemaNormalization {
	readonly ok: boolean;
	readonly schema?: Record<string, unknown>;
	readonly reason?: string;
}

/** Accept an object-root JSON Schema subset; reject unsafe/out-of-bound shapes. */
export function normalizeToolSchema(raw: unknown): SchemaNormalization {
	if (raw === undefined || raw === null) return { ok: true, schema: { type: "object", properties: {} } };
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "input schema must be an object" };
	const schema = raw as Record<string, unknown>;
	if (schema.type !== undefined && schema.type !== "object") return { ok: false, reason: "input schema root must have type object" };
	const bytes = Buffer.byteLength(JSON.stringify(schema), "utf8");
	if (bytes > MCP_LIMITS.maxSchemaBytes) return { ok: false, reason: `input schema exceeds ${MCP_LIMITS.maxSchemaBytes} bytes` };
	const inspection = inspectNode(schema, 0, { properties: 0, unions: 0 });
	if (inspection) return { ok: false, reason: inspection };
	return { ok: true, schema: { type: "object", ...schema } };
}

function inspectNode(node: unknown, depth: number, counters: { properties: number; unions: number }): string | undefined {
	if (depth > MCP_LIMITS.maxSchemaDepth) return `schema exceeds depth ${MCP_LIMITS.maxSchemaDepth}`;
	if (Array.isArray(node)) {
		for (const item of node) {
			const problem = inspectNode(item, depth + 1, counters);
			if (problem) return problem;
		}
		return undefined;
	}
	if (!node || typeof node !== "object") return undefined;
	const record = node as Record<string, unknown>;
	if (typeof record.$ref === "string") {
		// Internal refs and recursion are rejected with external refs: Slice A
		// accepts only the self-contained subset current tool providers emit.
		return "schema $ref is not supported";
	}
	if (record.$dynamicRef !== undefined || record.$recursiveRef !== undefined) return "recursive schema references are not supported";
	if (record.format === "regex" || typeof record.pattern === "string" && record.pattern.length > 512) return "excessive or executable format constraints are not supported";
	for (const unionKey of ["anyOf", "oneOf", "allOf"] as const) {
		const union = record[unionKey];
		if (Array.isArray(union)) {
			counters.unions += union.length;
			if (counters.unions > 64) return "schema union fan-out exceeds the supported bound";
		}
	}
	if (record.properties && typeof record.properties === "object" && !Array.isArray(record.properties)) {
		counters.properties += Object.keys(record.properties as object).length;
		if (counters.properties > MCP_LIMITS.maxSchemaProperties) {
			return `schema exceeds ${MCP_LIMITS.maxSchemaProperties} total properties`;
		}
	}
	for (const value of Object.values(record)) {
		const problem = inspectNode(value, depth + 1, counters);
		if (problem) return problem;
	}
	return undefined;
}

const NAME_SAFE = /[^a-z0-9_]/gu;

/**
 * Deterministic provider-safe exposed name:
 * `mcp_<normalized-server-id>_<normalized-remote-name>`, at most 64 chars.
 * Normalization or truncation appends sha256(serverId + "\0" + remoteName)[0..8).
 */
export function exposedToolName(serverId: string, remoteName: string): string {
	const normalizedServer = serverId.toLowerCase().replace(NAME_SAFE, "_");
	const normalizedTool = remoteName.toLowerCase().replace(NAME_SAFE, "_");
	const plain = `mcp_${normalizedServer}_${normalizedTool}`;
	const lossless = normalizedTool === remoteName && normalizedServer === serverId;
	if (lossless && plain.length <= 64) return plain;
	const hash = createHash("sha256").update(`${serverId}\0${remoteName}`).digest("hex").slice(0, 8);
	const budget = 64 - hash.length - 1;
	return `${plain.slice(0, budget)}_${hash}`;
}

export function schemaFingerprint(schema: Record<string, unknown>): string {
	return createHash("sha256").update(canonicalJson(schema)).digest("hex");
}

export function catalogFingerprint(parts: readonly unknown[]): string {
	const hash = createHash("sha256");
	for (const part of parts) hash.update(canonicalJson(part)).update("\0");
	return hash.digest("hex");
}

/** Stable JSON with sorted object keys so fingerprints ignore key order. */
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
		return `{${entries.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}
