/*
 * FEAT-087 Phase 3 — JSON Schema (TypeBox output) → compact TypeScript
 * declaration rendering for the exec_code tool description.
 *
 * Codex reference: code-mode-protocol/src/json_schema_types.rs. The load-
 * bearing property is BOUNDEDNESS, not compression: every schema renders
 * within hard byte budgets and degrades to `unknown` instead of inflating
 * the prompt (cyclic refs, pathological nesting, oversized enums).
 */

/** Per-path expansion cap for local $ref cycles. */
const MAX_LOCAL_REF_EXPANSIONS_PER_PATH = 2;
/** Total $ref expansions per schema (DAG fan-out guard). */
const MAX_TOTAL_LOCAL_REF_EXPANSIONS = 32;
/** A single rendered schema beyond this budget degrades to `unknown`. */
export const MAX_RENDERED_SCHEMA_BYTES = 16_000;
/** Hard cap on renderer work per schema. */
const MAX_RENDER_WORK_BYTES = MAX_RENDERED_SCHEMA_BYTES * 4;
/** Enum unions longer than this collapse to the base type. */
const MAX_ENUM_MEMBERS = 24;
/** Nesting depth beyond this degrades to `unknown`. */
const MAX_DEPTH = 12;

interface RenderState {
	work: number;
	refExpansions: number;
	root: Record<string, unknown> | null;
}

function quoteKey(key: string): string {
	return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

function literalOf(value: unknown): string {
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (value === null) return "null";
	return "unknown";
}

function resolveLocalRef(ref: string, root: Record<string, unknown> | null): unknown {
	if (!root || !ref.startsWith("#/")) return null;
	let node: unknown = root;
	for (const part of ref.slice(2).split("/")) {
		if (!node || typeof node !== "object") return null;
		node = (node as Record<string, unknown>)[part.replace(/~1/g, "/").replace(/~0/g, "~")];
	}
	return node ?? null;
}

function renderNode(schema: unknown, state: RenderState, depth: number, refPath: readonly string[]): string {
	state.work += 8;
	if (state.work > MAX_RENDER_WORK_BYTES || depth > MAX_DEPTH) return "unknown";
	if (schema === true) return "unknown";
	if (schema === false) return "never";
	if (!schema || typeof schema !== "object") return "unknown";
	const node = schema as Record<string, unknown>;

	if (typeof node.$ref === "string") {
		const count = refPath.filter((seen) => seen === node.$ref).length;
		if (count >= MAX_LOCAL_REF_EXPANSIONS_PER_PATH || state.refExpansions >= MAX_TOTAL_LOCAL_REF_EXPANSIONS) {
			return "unknown";
		}
		const resolved = resolveLocalRef(node.$ref, state.root);
		if (resolved === null) return "unknown";
		state.refExpansions += 1;
		return renderNode(resolved, state, depth + 1, [...refPath, node.$ref]);
	}

	if (Array.isArray(node.enum)) {
		if (node.enum.length === 0 || node.enum.length > MAX_ENUM_MEMBERS) return typeOfBase(node);
		return node.enum.map(literalOf).join(" | ");
	}
	if (node.const !== undefined) return literalOf(node.const);

	for (const combiner of ["anyOf", "oneOf"] as const) {
		const branches = node[combiner];
		if (Array.isArray(branches) && branches.length > 0) {
			if (branches.length > MAX_ENUM_MEMBERS) return "unknown";
			const parts = branches.map((branch) => renderNode(branch, state, depth + 1, refPath));
			return [...new Set(parts)].join(" | ");
		}
	}
	if (Array.isArray(node.allOf) && node.allOf.length > 0) {
		const parts = node.allOf.map((branch) => renderNode(branch, state, depth + 1, refPath)).filter((part) => part !== "unknown");
		return parts.length > 0 ? parts.join(" & ") : "unknown";
	}

	return typeOfBase(node, state, depth, refPath);
}

function typeOfBase(
	node: Record<string, unknown>,
	state?: RenderState,
	depth = 0,
	refPath: readonly string[] = [],
): string {
	const type = node.type;
	if (type === "string") return "string";
	if (type === "number" || type === "integer") return "number";
	if (type === "boolean") return "boolean";
	if (type === "null") return "null";
	if (type === "array") {
		if (!state) return "unknown[]";
		const item = renderNode(node.items, state, depth + 1, refPath);
		return item.includes(" ") ? `(${item})[]` : `${item}[]`;
	}
	if (type === "object" || node.properties) {
		if (!state) return "object";
		const properties = (node.properties ?? {}) as Record<string, unknown>;
		const required = new Set(Array.isArray(node.required) ? (node.required as string[]) : []);
		// Property-level descriptions are deliberately dropped (Codex does the
		// same): the compression target is names + types; the tool-level JSDoc
		// plus ALL_TOOLS carry the prose.
		const entries = Object.entries(properties).map(
			([key, child]) => `${quoteKey(key)}${required.has(key) ? "" : "?"}: ${renderNode(child, state, depth + 1, refPath)}`,
		);
		if (entries.length === 0) {
			const additional = node.additionalProperties;
			if (additional && typeof additional === "object") {
				return `Record<string, ${renderNode(additional, state, depth + 1, refPath)}>`;
			}
			return "Record<string, unknown>";
		}
		return `{ ${entries.join("; ")} }`;
	}
	return "unknown";
}

/** First sentence (or first line), compacted — JSDoc in declarations must not
 *  re-pay the full description cost the schema list already carries. */
export function firstSentence(description: string): string {
	const line = description.split("\n", 1)[0]!.trim();
	const period = line.indexOf(". ");
	const sentence = period >= 0 ? line.slice(0, period + 1) : line;
	return sentence.length > 160 ? `${sentence.slice(0, 157)}…` : sentence;
}

export interface RenderedToolDeclaration {
	readonly name: string;
	readonly declaration: string;
	/** True when the args type degraded to `unknown` under a budget. */
	readonly degraded: boolean;
}

/** Render one tool's facade entry: JSDoc line + method signature. */
export function renderToolDeclaration(
	name: string,
	description: string | undefined,
	parametersSchema: unknown,
): RenderedToolDeclaration {
	const state: RenderState = {
		work: 0,
		refExpansions: 0,
		root: parametersSchema && typeof parametersSchema === "object" ? (parametersSchema as Record<string, unknown>) : null,
	};
	let args = renderNode(parametersSchema, state, 0, []);
	let degraded = false;
	if (Buffer.byteLength(args, "utf8") > MAX_RENDERED_SCHEMA_BYTES) {
		args = "unknown";
		degraded = true;
	}
	if (args === "unknown") degraded = true;
	const jsDoc = description ? `\t/** ${firstSentence(description)} */\n` : "";
	return {
		name,
		declaration: `${jsDoc}\t${quoteKey(name)}(args: ${args}): Promise<ToolResult>;`,
		degraded,
	};
}

export interface ToolDeclarationInput {
	readonly name: string;
	readonly description?: string;
	readonly parametersSchema: unknown;
}

export interface RenderedDeclarations {
	/** The full ```ts block body: ToolResult + declare const tools. */
	readonly block: string;
	readonly degradedTools: readonly string[];
	readonly bytes: number;
}

/** Render the whole `declare const tools` block for the exec_code
 *  description, with the shared result envelope hoisted once. */
export function renderToolsDeclarationBlock(tools: readonly ToolDeclarationInput[]): RenderedDeclarations {
	const degradedTools: string[] = [];
	const members = tools.map((tool) => {
		const rendered = renderToolDeclaration(tool.name, tool.description, tool.parametersSchema);
		if (rendered.degraded) degradedTools.push(tool.name);
		return rendered.declaration;
	});
	const block = [
		"interface ToolResult { output: string; details?: unknown }",
		"declare const tools: {",
		...members,
		"};",
	].join("\n");
	return { block, degradedTools, bytes: Buffer.byteLength(block, "utf8") };
}
