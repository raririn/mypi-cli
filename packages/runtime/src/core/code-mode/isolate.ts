/*
 * FEAT-087 Phase 1 — Code Mode isolate runtime.
 *
 * One fresh QuickJS-WASM isolate per executed cell (Codex code-mode-runtime
 * pattern: fresh isolate, ES-module eval with top-level await, lifetime ends
 * with the script; unawaited promises die with it). The isolate has NO I/O
 * bindings — no fs, no net, no console, no timers, no imports. Every effect
 * routes through the single asyncified `__host_invoke` boundary, and the
 * `tools.*` facade is built INSIDE the isolate from that primitive, so no
 * host object ever crosses the membrane (data-only JSON both ways).
 *
 * Engine choice (FEAT-087 §11.1): quickjs-emscripten asyncify build — honest
 * in-process isolation with real memory limits and interrupt metering, zero
 * native dependencies. NOT node:vm (not a security boundary; timeouts do not
 * survive `await`).
 *
 * Known engine subtleties this module owns (validated by spike, 2026-08-26):
 * - Module evaluation completes with a PENDING promise when the script uses
 *   pure-JS awaits; the runtime must pump executePendingJobs() until the
 *   completion promise settles, under the same interrupt deadline.
 * - Every handle must be disposed or QuickJS aborts on runtime dispose
 *   (gc_obj_list assertion); handle lifetimes here are kept short and local.
 * - An interrupt inside a job surfaces as InternalError "interrupted"; the
 *   deadline flag — not the message — decides the "timeout" classification.
 */
import { newAsyncRuntime, type QuickJSAsyncContext, type QuickJSAsyncRuntime, type QuickJSHandle } from "quickjs-emscripten";

/** Host tool implementations MUST observe the abort signal: it fires when the
 *  cell's wall clock expires, and it is the only way to unwind an isolate
 *  suspended inside a host call (interrupts cannot fire while suspended). */
export type HostFunction = (args: unknown, signal: AbortSignal) => Promise<unknown>;

export interface CodeCellOptions {
	/** Wall-clock budget for the whole cell, host awaits included. */
	readonly timeoutMs?: number;
	readonly memoryLimitBytes?: number;
	readonly maxStackBytes?: number;
	/** Async host functions surfaced as `await tools.<name>(args)`. */
	readonly tools?: Readonly<Record<string, HostFunction>>;
	/** Session-owned cross-cell scratchpad backing store()/load(). */
	readonly scratchpad?: Map<string, unknown>;
	readonly maxEmittedItems?: number;
	readonly maxEmittedBytes?: number;
	readonly maxScratchpadBytes?: number;
}

export interface CodeCellEmit {
	readonly type: "text";
	readonly text: string;
}

export interface CodeCellError {
	readonly name: string;
	readonly message: string;
	/** QuickJS stack excerpt, e.g. "at <anonymous> (cell.mjs:2:5)". */
	readonly stack?: string;
}

export type CodeCellStatus = "ok" | "error" | "timeout" | "memory";

export interface CodeCellResult {
	readonly status: CodeCellStatus;
	readonly error?: CodeCellError;
	/** Curated output in emit order (R5: the ONLY channel back to the model). */
	readonly emitted: readonly CodeCellEmit[];
	readonly wallTimeMs: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MEMORY_LIMIT_BYTES = 128 * 1024 * 1024;
/** Must stay small enough that QuickJS throws its own "stack overflow"
 *  BEFORE WASM-nested recursion can blow the host's stack (a host RangeError
 *  escapes as an unhandled rejection and corrupts isolate disposal). 256 KB
 *  verified safe; 1 MB verified NOT safe. */
const DEFAULT_MAX_STACK_BYTES = 256 * 1024;
const DEFAULT_MAX_EMITTED_ITEMS = 256;
const DEFAULT_MAX_EMITTED_BYTES = 1024 * 1024;
const DEFAULT_MAX_SCRATCHPAD_BYTES = 4 * 1024 * 1024;
/** Thrown by exit(); recognized by name so scripts cannot fake a crash. */
const EXIT_SENTINEL = "__MYPI_CODE_CELL_EXIT__";
/** After the deadline aborts host calls, how long to wait for the evaluation
 *  to unwind before parking the isolate for deferred disposal. */
const TIMEOUT_SETTLE_GRACE_MS = 500;

/** In-isolate prelude: builds the `tools` facade and helper globals from the
 *  primitive host bindings, then removes the primitives from global scope so
 *  scripts only ever see the curated surface. */
function preludeSource(toolNames: readonly string[]): string {
	return `
const __invoke = globalThis.__host_invoke;
const __emit = globalThis.__host_emit;
const __store = globalThis.__host_store;
const __load = globalThis.__host_load;
delete globalThis.__host_invoke;
delete globalThis.__host_emit;
delete globalThis.__host_store;
delete globalThis.__host_load;

const tools = Object.create(null);
for (const name of ${JSON.stringify(toolNames)}) {
	tools[name] = async (args) => {
		const raw = await __invoke(name, JSON.stringify(args ?? {}));
		const parsed = JSON.parse(raw);
		if (parsed && parsed.__hostError) {
			const error = new Error(parsed.__hostError.message);
			error.name = parsed.__hostError.name;
			throw error;
		}
		return parsed.result;
	};
	Object.freeze(tools[name]);
}
globalThis.tools = Object.freeze(tools);

globalThis.text = (value) => { __emit("text", String(value)); };
globalThis.store = (key, value) => { __store(String(key), JSON.stringify(value === undefined ? null : value)); };
globalThis.load = (key) => JSON.parse(__load(String(key)));
globalThis.exit = () => { const e = new Error("${EXIT_SENTINEL}"); e.name = "${EXIT_SENTINEL}"; throw e; };
`;
}

function formatError(dumped: unknown): CodeCellError {
	if (dumped && typeof dumped === "object") {
		const record = dumped as Record<string, unknown>;
		return {
			name: typeof record.name === "string" ? record.name : "Error",
			message: typeof record.message === "string" ? record.message : JSON.stringify(dumped),
			...(typeof record.stack === "string" && record.stack.trim() ? { stack: record.stack.trim() } : {}),
		};
	}
	return { name: "Error", message: String(dumped) };
}

function utf8Length(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/** Execute one code cell to completion in a fresh isolate. Never throws for
 *  script-level failures — everything is classified into CodeCellResult. */
export async function runCodeCell(source: string, options: CodeCellOptions = {}): Promise<CodeCellResult> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const started = Date.now();
	const deadline = started + timeoutMs;
	let interrupted = false;

	const emitted: CodeCellEmit[] = [];
	let emittedBytes = 0;
	const maxEmittedItems = options.maxEmittedItems ?? DEFAULT_MAX_EMITTED_ITEMS;
	const maxEmittedBytes = options.maxEmittedBytes ?? DEFAULT_MAX_EMITTED_BYTES;
	const scratchpad = options.scratchpad ?? new Map<string, unknown>();
	const maxScratchpadBytes = options.maxScratchpadBytes ?? DEFAULT_MAX_SCRATCHPAD_BYTES;
	const tools = options.tools ?? {};

	// Cell-scoped abort: fired at the wall deadline so host calls unwind the
	// suspended WASM stack (interrupts cannot fire while suspended).
	const hostAbort = new AbortController();

	const runtime: QuickJSAsyncRuntime = await newAsyncRuntime();
	runtime.setMemoryLimit(options.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES);
	runtime.setMaxStackSize(options.maxStackBytes ?? DEFAULT_MAX_STACK_BYTES);
	runtime.setInterruptHandler(() => {
		if (Date.now() > deadline) {
			interrupted = true;
			return true;
		}
		return false;
	});
	const ctx: QuickJSAsyncContext = runtime.newContext();

	let disposed = false;
	const disposeIsolate = () => {
		if (disposed) return;
		disposed = true;
		try {
			ctx.dispose();
			runtime.dispose();
		} catch {
			// A dispose crash must never take the host down; the isolate leaks.
		}
	};
	const finish = (result: Omit<CodeCellResult, "wallTimeMs">): CodeCellResult => ({
		...result,
		wallTimeMs: Date.now() - started,
	});

	const classify = (error: CodeCellError): CodeCellResult["status"] | "exit" => {
		if (error.name === EXIT_SENTINEL || error.message === EXIT_SENTINEL) return "exit";
		if (interrupted) return "timeout";
		if (/out of memory/i.test(error.message)) return "memory";
		return "error";
	};

	try {
		// --- host bindings (primitives; the prelude hides them again) ---
		const invoke = ctx.newAsyncifiedFunction("__host_invoke", async (nameHandle, argsHandle) => {
			const name = ctx.getString(nameHandle);
			const argsJson = ctx.getString(argsHandle);
			try {
				const fn = Object.prototype.hasOwnProperty.call(tools, name) ? tools[name] : undefined;
				if (!fn) return ctx.newString(JSON.stringify({ __hostError: { name: "Error", message: `Unknown tool: ${name}` } }));
				if (hostAbort.signal.aborted) throw new Error("Execution deadline exceeded.");
				const result = await fn(JSON.parse(argsJson), hostAbort.signal);
				return ctx.newString(JSON.stringify({ result: result === undefined ? null : result }));
			} catch (error) {
				const err = error instanceof Error ? { name: error.name || "Error", message: error.message } : { name: "Error", message: String(error) };
				return ctx.newString(JSON.stringify({ __hostError: err }));
			}
		});
		ctx.setProp(ctx.global, "__host_invoke", invoke);
		invoke.dispose();

		const emit = ctx.newFunction("__host_emit", (typeHandle, textHandle) => {
			const type = ctx.getString(typeHandle);
			const textValue = ctx.getString(textHandle);
			// Thrown host errors become isolate exceptions (catchable in-script).
			if (type !== "text") throw new Error(`Unknown emit type: ${type}`);
			if (emitted.length >= maxEmittedItems || emittedBytes + utf8Length(textValue) > maxEmittedBytes) {
				throw new Error("Output budget exceeded — emit less via text() or raise max_output_tokens.");
			}
			emitted.push({ type: "text", text: textValue });
			emittedBytes += utf8Length(textValue);
			return ctx.undefined;
		});
		ctx.setProp(ctx.global, "__host_emit", emit);
		emit.dispose();

		const storeFn = ctx.newFunction("__host_store", (keyHandle, jsonHandle) => {
			const key = ctx.getString(keyHandle);
			const json = ctx.getString(jsonHandle);
			const currentBytes = [...scratchpad.entries()]
				.filter(([existing]) => existing !== key)
				.reduce((sum, [, value]) => sum + utf8Length(JSON.stringify(value)), 0);
			if (currentBytes + utf8Length(json) > maxScratchpadBytes) {
				throw new Error("Scratchpad budget exceeded — store() less data.");
			}
			scratchpad.set(key, JSON.parse(json));
			return ctx.undefined;
		});
		ctx.setProp(ctx.global, "__host_store", storeFn);
		storeFn.dispose();

		const loadFn = ctx.newFunction("__host_load", (keyHandle) => {
			const key = ctx.getString(keyHandle);
			return ctx.newString(JSON.stringify(scratchpad.has(key) ? scratchpad.get(key) : null));
		});
		ctx.setProp(ctx.global, "__host_load", loadFn);
		loadFn.dispose();

		// --- prelude (facade construction; plain script, no awaits) ---
		const prelude = ctx.evalCode(preludeSource(Object.keys(tools)), "prelude.js");
		if (prelude.error) {
			const error = formatError(ctx.dump(prelude.error));
			prelude.error.dispose();
			disposeIsolate();
			return finish({ status: "error", error, emitted });
		}
		prelude.value.dispose();

		// --- the cell itself: ES module for top-level await ---
		// The evaluation (including asyncified suspensions inside host calls)
		// races the wall deadline. On deadline: abort host calls, give the
		// stack a short grace to unwind, then PARK the isolate — disposal
		// while suspended would abort the WASM module, so a never-settling
		// host call defers disposal to whenever the evaluation finally ends.
		const evaluate = async (): Promise<{ error?: CodeCellError }> => {
			const evaluated = await ctx.evalCodeAsync(source, "cell.mjs", { type: "module" });
			if (evaluated.error) {
				const error = formatError(ctx.dump(evaluated.error));
				evaluated.error.dispose();
				return { error };
			}
			// Module completion is a promise; pump pending jobs until it
			// settles (pure-JS awaits queue jobs evalCodeAsync doesn't drain).
			const completion = evaluated.value;
			let settled: { error?: CodeCellError } | null = null;
			void ctx.resolvePromise(completion).then((result) => {
				if ("error" in result && result.error) {
					const error = formatError(ctx.dump(result.error));
					result.error.dispose();
					settled = { error };
				} else {
					if ("value" in result) result.value.dispose();
					settled = {};
				}
			});
			while (settled === null && !hostAbort.signal.aborted) {
				const jobs = runtime.executePendingJobs();
				if ("error" in jobs && jobs.error) jobs.error.dispose();
				// Macrotask turn for asyncified host promises + resolvePromise.
				await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
			}
			completion.dispose();
			return settled ?? { error: { name: "TimeoutError", message: `Execution exceeded ${timeoutMs}ms.` } };
		};

		const evaluation = evaluate();
		let timedOut = false;
		const outcome = await Promise.race([
			evaluation,
			new Promise<null>((resolvePromise) => {
				const timer = setTimeout(() => {
					timedOut = true;
					resolvePromise(null);
				}, Math.max(0, deadline - Date.now()));
				timer.unref?.();
				void evaluation.finally(() => clearTimeout(timer));
			}),
		]);

		if (outcome === null && timedOut) {
			interrupted = true;
			hostAbort.abort(new Error("Execution deadline exceeded."));
			// Grace for the suspended stack to unwind through aborted hosts.
			const settledInGrace = await Promise.race([
				evaluation.then(() => true),
				new Promise<false>((resolvePromise) => {
					const timer = setTimeout(() => resolvePromise(false), TIMEOUT_SETTLE_GRACE_MS);
					timer.unref?.();
				}),
			]);
			if (settledInGrace) {
				disposeIsolate();
			} else {
				// Parked: dispose whenever the evaluation eventually settles.
				void evaluation.finally(disposeIsolate);
			}
			return finish({
				status: "timeout",
				error: { name: "TimeoutError", message: `Execution exceeded ${timeoutMs}ms.` },
				emitted,
			});
		}

		const failure = (outcome as { error?: CodeCellError }).error;
		disposeIsolate();
		if (failure) {
			const status = classify(failure);
			return finish(status === "exit" ? { status: "ok", emitted } : { status, error: failure, emitted });
		}
		return finish({ status: "ok", emitted });
	} catch (error) {
		// Engine-level throw (never a script error): classify conservatively.
		const formatted: CodeCellError =
			error instanceof Error ? { name: error.name || "Error", message: error.message } : { name: "Error", message: String(error) };
		disposeIsolate();
		return finish({ status: interrupted ? "timeout" : "error", error: formatted, emitted });
	}
}
