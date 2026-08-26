/*
 * FEAT-087 Phase 2 — tool bridge: projects a session's ACTIVE tool list (the
 * post-safety-substitution `agent.state.tools`, never the raw registry) into
 * the isolate's `tools.*` facade, routing every nested call through the same
 * per-call pipeline as a model-issued call (validation, beforeToolCall
 * safety/extension/hook gates, events with a code_mode source tag).
 *
 * The bridge depends on an abstract executor so the isolate layer stays free
 * of AgentSession; the session implements CodeModeToolExecutor (Phase 3
 * registers the exec_code tool that wires them together).
 */
import type { HostFunction } from "./isolate.ts";

export interface CodeModeToolDescriptor {
	readonly name: string;
	readonly description?: string;
	readonly executionMode?: "sequential" | "parallel";
}

export interface CodeModeExecutionOutcome {
	/** Model-shaped result content collapsed for the script. */
	readonly output: string;
	readonly details?: unknown;
	readonly isError: boolean;
}

export interface CodeModeToolExecutor {
	listTools(): readonly CodeModeToolDescriptor[];
	execute(name: string, args: unknown, signal: AbortSignal): Promise<CodeModeExecutionOutcome>;
}

/** Reserved facade name for the host-side fan-out primitive (asyncify cannot
 *  run concurrent host awaits inside a cell — FEAT-087 §11.9). */
export const PARALLEL_PRIMITIVE = "__parallel";

/** Map a tool name onto a valid JS identifier (Codex: normalize, first wins —
 *  MyPi: collisions are a loud failure; tool names are controlled). */
export function normalizeCodeModeIdentifier(name: string): string {
	const normalized = name.replace(/[^A-Za-z0-9_$]/g, "_");
	return /^[0-9]/.test(normalized) ? `_${normalized}` : normalized;
}

export interface CodeModeBridge {
	/** Host functions for CodeCellOptions.tools (includes __parallel). */
	readonly tools: Readonly<Record<string, HostFunction>>;
	/** name/description metadata for the ALL_TOOLS global (Phase 3). */
	readonly allTools: readonly { name: string; description: string }[];
}

interface ParallelCallRequest {
	readonly tool: string;
	readonly args?: unknown;
}

function collapseOutcome(outcome: CodeModeExecutionOutcome): { output: string; details?: unknown } {
	// details must survive the JSON membrane; anything non-serializable is
	// dropped rather than crashing the cell.
	let details: unknown;
	if (outcome.details !== undefined) {
		try {
			details = JSON.parse(JSON.stringify(outcome.details));
		} catch {
			details = undefined;
		}
	}
	return { output: outcome.output, ...(details === undefined ? {} : { details }) };
}

export function buildCodeModeBridge(executor: CodeModeToolExecutor): CodeModeBridge {
	const descriptors = executor.listTools();
	const byIdentifier = new Map<string, CodeModeToolDescriptor>();
	for (const descriptor of descriptors) {
		const identifier = normalizeCodeModeIdentifier(descriptor.name);
		const existing = byIdentifier.get(identifier);
		if (existing) {
			throw new Error(
				`Code mode tool name collision: "${existing.name}" and "${descriptor.name}" both normalize to "${identifier}".`,
			);
		}
		byIdentifier.set(identifier, descriptor);
	}

	const invokeOne = async (descriptor: CodeModeToolDescriptor, args: unknown, signal: AbortSignal) => {
		const outcome = await executor.execute(descriptor.name, args, signal);
		if (outcome.isError) {
			const error = new Error(outcome.output || `Tool ${descriptor.name} failed.`);
			error.name = "ToolError";
			throw error;
		}
		return collapseOutcome(outcome);
	};

	const tools: Record<string, HostFunction> = {};
	for (const [identifier, descriptor] of byIdentifier) {
		tools[identifier] = (args, signal) => invokeOne(descriptor, args, signal);
	}

	tools[PARALLEL_PRIMITIVE] = async (rawCalls, signal) => {
		const calls = Array.isArray(rawCalls) ? (rawCalls as ParallelCallRequest[]) : null;
		if (!calls || calls.some((call) => !call || typeof call.tool !== "string")) {
			throw new Error('parallel() expects an array of { tool: "name", args? } entries.');
		}
		const resolved = calls.map((call) => {
			const descriptor = byIdentifier.get(normalizeCodeModeIdentifier(call.tool));
			if (!descriptor) throw new Error(`parallel(): unknown tool "${call.tool}".`);
			return { descriptor, args: call.args ?? {} };
		});
		// Same batch rule as the agent loop: one sequential tool serializes
		// the whole batch, in request order. Item failures are item results —
		// one denial must not void the other calls' work.
		const runOne = async (entry: { descriptor: CodeModeToolDescriptor; args: unknown }) => {
			try {
				return { ok: true as const, ...(await invokeOne(entry.descriptor, entry.args, signal)) };
			} catch (error) {
				return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
			}
		};
		const hasSequential = resolved.some((entry) => entry.descriptor.executionMode === "sequential");
		if (hasSequential) {
			const results = [];
			for (const entry of resolved) results.push(await runOne(entry));
			return results;
		}
		return Promise.all(resolved.map(runOne));
	};

	return {
		tools,
		allTools: descriptors.map((descriptor) => ({
			name: normalizeCodeModeIdentifier(descriptor.name),
			description: descriptor.description ?? "",
		})),
	};
}
