/*
 * FEAT-087 Phase 3 — the exec_code tool definition.
 *
 * Multi-provider JSON function tool (freeform/grammar variants can layer on
 * via constrainedSampling later). The description IS the documentation
 * (Codex lesson: the system prompt stays untouched):
 * - tools.mode = "code": per-tool schemas remain advertised, so the
 *   description carries only the runtime contract — no declaration block,
 *   no duplicated cost.
 * - tools.mode = "code-only": schemas are hidden from the model, so the
 *   description embeds the rendered TS declarations for the callable set.
 */
import { Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { buildCodeModeBridge, type CodeModeToolExecutor } from "./bridge.ts";
import { runCodeCell } from "./isolate.ts";
import { renderToolsDeclarationBlock, type ToolDeclarationInput } from "./ts-declarations.ts";

export const EXEC_CODE_TOOL_NAME = "exec_code";

const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 30_000;
/** Rough proxy used to convert max_output_tokens into an emit byte budget. */
const BYTES_PER_TOKEN = 4;

const CONTRACT = `Execute JavaScript in an isolated runtime to orchestrate tools in one turn.

- The code runs as an async ES module: top-level await is allowed. Raw source only — no JSON wrapping, no markdown fences.
- Every session tool is available as \`await tools.<name>(args)\` returning { output: string, details?: unknown }. Failed calls throw (catchable); denials by the user or safety policy throw too — do not retry a denied call.
- No Node, no filesystem, no network, no console, no timers, no imports: ALL effects go through tools.*.
- Output: ONLY what you pass to text(...) reaches the conversation — intermediate values and the module's completion value are discarded. Emit small, curated results.
- \`Promise.all\` over tools.* runs host-side concurrently. \`parallel([{ tool, args }, ...])\` batches with per-tool execution-mode rules and per-item results.
- store(key, value) / load(key) persist JSON values across exec_code calls this session. exit() ends the script early. ALL_TOOLS lists { name, description } for every callable tool (including ones not declared below).
- When the script finishes, its runtime is destroyed; unawaited promises are silently discarded.
- exec_code cannot invoke itself.
- Prefer direct tool calls for single operations; use exec_code when a workflow needs loops, filtering, aggregation, or multiple dependent calls.`;

const execCodeSchema = Type.Object({
	code: Type.String({ description: "Raw JavaScript source, evaluated as an async ES module in the isolated runtime." }),
	timeout_ms: Type.Optional(
		Type.Number({ description: `Execution budget override in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).` }),
	),
	max_output_tokens: Type.Optional(
		Type.Number({ description: "Cap on emitted output returned to you (default 10000 tokens)." }),
	),
});

export interface ExecCodeToolInput {
	code: string;
	timeout_ms?: number;
	max_output_tokens?: number;
}

export interface ExecCodeSessionSurface {
	listCodeModeTools(): readonly { name: string; description?: string; executionMode?: "sequential" | "parallel" }[];
	executeToolForCodeMode(
		name: string,
		args: unknown,
		options: { readonly parentToolCallId: string; readonly signal?: AbortSignal },
	): Promise<{ result: { content?: unknown; details?: unknown }; isError: boolean; message: { content: unknown; details?: unknown } }>;
	/** Session-lifetime scratchpad for store()/load(). */
	readonly codeModeScratchpad: Map<string, unknown>;
	/** Direct-model-only names excluded from the nested surface. */
	codeModeDirectOnlyTools(): ReadonlySet<string>;
}

function contentToText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((block) =>
			block && typeof block === "object" && (block as { type?: string }).type === "text"
				? String((block as { text?: unknown }).text ?? "")
				: "",
		)
		.filter(Boolean)
		.join("\n");
}

/** The nested-callable descriptor list: active tools minus exec_code itself
 *  and minus direct-model-only communication tools. */
export function codeCallableDescriptors(session: ExecCodeSessionSurface): readonly {
	name: string;
	description?: string;
	executionMode?: "sequential" | "parallel";
}[] {
	const directOnly = session.codeModeDirectOnlyTools();
	return session
		.listCodeModeTools()
		.filter((tool) => tool.name !== EXEC_CODE_TOOL_NAME && !directOnly.has(tool.name));
}

function executorFor(session: ExecCodeSessionSurface, parentToolCallId: string): CodeModeToolExecutor {
	return {
		listTools: () => codeCallableDescriptors(session),
		execute: async (name, args, signal) => {
			const outcome = await session.executeToolForCodeMode(name, args, { parentToolCallId, signal });
			return {
				output: contentToText(outcome.message.content),
				details: outcome.message.details,
				isError: outcome.isError,
			};
		},
	};
}

/** Description for the current mode + callable set. Recomputed on registry
 *  refresh so mode changes and dynamic tools (mcp_load) stay accurate. */
export function renderExecCodeDescription(
	mode: "compatible" | "code",
	callable: readonly { name: string; description?: string; parametersSchema?: unknown }[],
): string {
	if (mode === "compatible") {
		return `${CONTRACT}\n\ntools.* mirrors the visible tool list (same names, same parameters as their schemas).`;
	}
	const inputs: ToolDeclarationInput[] = callable.map((tool) => ({
		name: tool.name,
		...(tool.description ? { description: tool.description } : {}),
		parametersSchema: tool.parametersSchema ?? {},
	}));
	const rendered = renderToolsDeclarationBlock(inputs);
	return `${CONTRACT}\n\nexec tool declarations:\n\`\`\`ts\n${rendered.block}\n\`\`\``;
}

export function createExecCodeToolDefinition(
	session: ExecCodeSessionSurface,
	description: string,
): ToolDefinition<typeof execCodeSchema, { status: string; wallTimeMs: number }> {
	return {
		name: EXEC_CODE_TOOL_NAME,
		label: "Execute code",
		description,
		parameters: execCodeSchema,
		// Sequential: a cell manages its own internal concurrency; racing a
		// cell against other model-issued calls would double-run policies.
		executionMode: "sequential",
		execute: async (toolCallId, params, signal) => {
			const input = params as ExecCodeToolInput;
			const timeoutMs = Math.min(Math.max(input.timeout_ms ?? DEFAULT_TIMEOUT_MS, 1_000), MAX_TIMEOUT_MS);
			const bridge = buildCodeModeBridge(executorFor(session, toolCallId));
			let result: Awaited<ReturnType<typeof runCodeCell>>;
			try {
				result = await runCodeCell(input.code, {
					tools: bridge.tools,
					allTools: bridge.allTools,
					timeoutMs,
					scratchpad: session.codeModeScratchpad,
					...(signal ? { abortSignal: signal } : {}),
					...(input.max_output_tokens ? { maxEmittedBytes: Math.max(1024, input.max_output_tokens * BYTES_PER_TOKEN) } : {}),
				});
			} catch (error) {
				// Engine-level failure (e.g. the QuickJS WASM could not load):
				// actionable guidance instead of a bare stack.
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{
						type: "text",
						text: `Exit: runtime-unavailable: ${message}\nThe code-mode runtime failed to load. Ask the user to restart the MyPi daemon, or to set tools.mode: flat in config.yaml (and restart) to disable code mode.`,
					}],
					details: { status: "runtime-unavailable", wallTimeMs: 0 },
				};
			}
			const body = result.emitted.map((item) => item.text).join("\n");
			const status = result.status === "ok" ? "ok" : `${result.status}${result.error ? `: ${result.error.message}` : ""}`;
			const header = `Exit: ${status}\nWall time: ${(result.wallTimeMs / 1000).toFixed(1)}s`;
			const text = body ? `${header}\nOutput:\n${body}` : `${header}\nOutput: (empty — use text(...) to emit results)`;
			// Failures return structured status text rather than throwing — the
			// model reads "Exit: error: …" and self-corrects (Codex pattern).
			return {
				content: [{ type: "text", text }],
				details: { status: result.status, wallTimeMs: result.wallTimeMs },
			};
		},
	};
}
