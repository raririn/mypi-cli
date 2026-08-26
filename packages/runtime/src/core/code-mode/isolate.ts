/*
 * FEAT-087 Phase 1/2 — Code Mode isolate runtime.
 *
 * One fresh QuickJS-WASM runtime per executed cell (Codex code-mode-runtime
 * pattern: fresh isolate, ES-module eval with top-level await, lifetime ends
 * with the script; unawaited promises die with it). The isolate has NO I/O
 * bindings — no fs, no net, no console, no timers, no imports. Every effect
 * routes through the single `__host_invoke` boundary, and the `tools.*`
 * facade is built INSIDE the isolate from that primitive, so no host object
 * ever crosses the membrane (data-only JSON both ways).
 *
 * Engine choice (FEAT-087 §11.1): quickjs-emscripten, SYNC build. Host calls
 * use the deferred-promise pattern — `__host_invoke` returns a QuickJS
 * promise resolved from the host, with pending jobs pumped until the module
 * completion promise settles. The asyncify build is deliberately NOT used:
 * its post-await handle bookkeeping corrupts the shared WASM heap on
 * disposal (gc_decref/js_free_shape aborts, verified 2026-08-26), and it
 * serializes concurrent host awaits. With the sync build, `Promise.all`
 * over `tools.*` gives REAL host-side concurrency.
 *
 * Engine subtleties this module owns:
 * - Module evaluation completes with a PENDING promise; the runtime pumps
 *   executePendingJobs() until the completion promise settles, under the
 *   interrupt deadline (pure-JS awaits queue jobs nothing else drains).
 * - Host-promise continuations may fire after the cell is closed (timeout);
 *   every continuation checks the closed flag before touching the context.
 * - Every handle must be disposed or QuickJS aborts on runtime dispose.
 * - The interrupt handler fires only while JS executes (evalCode and pumped
 *   jobs); waits on host promises are host-side, covered by the deadline
 *   check in the pump loop and the abort signal handed to host functions.
 */
import { getQuickJS, type QuickJSContext, type QuickJSRuntime } from "quickjs-emscripten";

/** Host tool implementations MUST observe the abort signal: it fires when
 *  the cell's wall clock expires so pending host work stops promptly. */
export type HostFunction = (args: unknown, signal: AbortSignal) => Promise<unknown>;

export interface CodeCellOptions {
	/** Wall-clock budget for the whole cell, host awaits included. */
	readonly timeoutMs?: number;
	readonly memoryLimitBytes?: number;
	readonly maxStackBytes?: number;
	/** Async host functions surfaced as `await tools.<name>(args)`. Names
	 *  starting with "__" are reserved primitives (e.g. __parallel) exposed
	 *  as dedicated globals rather than tools.* entries. */
	readonly tools?: Readonly<Record<string, HostFunction>>;
	/** name/description metadata for the ALL_TOOLS global. */
	readonly allTools?: readonly { readonly name: string; readonly description: string }[];
	/** Session-owned cross-cell scratchpad backing store()/load(). */
	readonly scratchpad?: Map<string, unknown>;
	/** External abort (user abort of the turn): ends the cell like a deadline. */
	readonly abortSignal?: AbortSignal;
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

/** In-isolate prelude: builds the `tools` facade and helper globals from the
 *  primitive host bindings, then removes the primitives from global scope so
 *  scripts only ever see the curated surface. */
function preludeSource(toolNames: readonly string[], allTools: readonly { name: string; description: string }[]): string {
	return `
const __invoke = globalThis.__host_invoke;
const __emit = globalThis.__host_emit;
const __store = globalThis.__host_store;
const __load = globalThis.__host_load;
delete globalThis.__host_invoke;
delete globalThis.__host_emit;
delete globalThis.__host_store;
delete globalThis.__host_load;

const __call = async (name, args) => {
	const raw = await __invoke(name, JSON.stringify(args ?? {}));
	const parsed = JSON.parse(raw);
	if (parsed && parsed.__hostError) {
		const error = new Error(parsed.__hostError.message);
		error.name = parsed.__hostError.name;
		throw error;
	}
	return parsed.result;
};

const tools = Object.create(null);
for (const name of ${JSON.stringify(toolNames)}) {
	if (name.startsWith("__")) continue; // reserved host primitives, not tools
	tools[name] = async (args) => __call(name, args);
	Object.freeze(tools[name]);
}
globalThis.tools = Object.freeze(tools);
globalThis.ALL_TOOLS = Object.freeze(${JSON.stringify(allTools)});
${
	toolNames.includes("__parallel")
		? `
// Execution-mode-aware host-side batch: parallel-safe tools fan out
// concurrently; any sequential tool serializes the batch in order. Item
// failures come back as { ok:false, error } entries. (Plain Promise.all
// over tools.* also runs concurrently; parallel() adds the mode rules.)
globalThis.parallel = async (calls) => __call("__parallel", calls);
`
		: ""
}
globalThis.text = (value) => { __emit("text", String(value)); };
// Weak-model rescue: console maps onto the curated output channel.
globalThis.console = Object.freeze({
	log: (...parts) => __emit("text", parts.map(String).join(" ")),
	info: (...parts) => __emit("text", parts.map(String).join(" ")),
	warn: (...parts) => __emit("text", parts.map(String).join(" ")),
	error: (...parts) => __emit("text", parts.map(String).join(" ")),
	debug: () => {},
});
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
	/** Set when the cell is finished; host-promise continuations that fire
	 *  later must not touch the (disposed) context. */
	let closed = false;

	const emitted: CodeCellEmit[] = [];
	let emittedBytes = 0;
	const maxEmittedItems = options.maxEmittedItems ?? DEFAULT_MAX_EMITTED_ITEMS;
	const maxEmittedBytes = options.maxEmittedBytes ?? DEFAULT_MAX_EMITTED_BYTES;
	const scratchpad = options.scratchpad ?? new Map<string, unknown>();
	const maxScratchpadBytes = options.maxScratchpadBytes ?? DEFAULT_MAX_SCRATCHPAD_BYTES;
	const tools = options.tools ?? {};

	// Cell-scoped abort: fired at the wall deadline so in-flight host work
	// stops promptly (the VM itself is idle while host promises are pending).
	const hostAbort = new AbortController();

	const QuickJS = await getQuickJS();
	const runtime: QuickJSRuntime = QuickJS.newRuntime();
	runtime.setMemoryLimit(options.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES);
	runtime.setMaxStackSize(options.maxStackBytes ?? DEFAULT_MAX_STACK_BYTES);
	runtime.setInterruptHandler(() => {
		if (Date.now() > deadline || options.abortSignal?.aborted) {
			interrupted = true;
			return true;
		}
		return false;
	});
	const ctx: QuickJSContext = runtime.newContext();

	const disposeIsolate = () => {
		if (closed) return;
		closed = true;
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

	const classify = (error: CodeCellError): CodeCellStatus | "exit" => {
		if (error.name === EXIT_SENTINEL || error.message === EXIT_SENTINEL) return "exit";
		if (interrupted) return "timeout";
		if (/out of memory/i.test(error.message)) return "memory";
		return "error";
	};

	try {
		// --- host bindings (primitives; the prelude hides them again) ---
		const invoke = ctx.newFunction("__host_invoke", (nameHandle, argsHandle) => {
			const name = ctx.getString(nameHandle);
			const argsJson = ctx.getString(argsHandle);
			const deferred = ctx.newPromise();
			const settle = (payload: string) => {
				if (closed || !deferred.alive) return;
				const handle = ctx.newString(payload);
				deferred.resolve(handle);
				handle.dispose();
			};
			void (async () => {
				try {
					const fn = Object.prototype.hasOwnProperty.call(tools, name) ? tools[name] : undefined;
					if (!fn) return JSON.stringify({ __hostError: { name: "Error", message: `Unknown tool: ${name}` } });
					if (hostAbort.signal.aborted) throw new Error("Execution deadline exceeded.");
					const result = await fn(JSON.parse(argsJson), hostAbort.signal);
					return JSON.stringify({ result: result === undefined ? null : result });
				} catch (error) {
					const err =
						error instanceof Error
							? { name: error.name || "Error", message: error.message }
							: { name: "Error", message: String(error) };
					return JSON.stringify({ __hostError: err });
				}
			})().then((payload) => {
				settle(payload);
				// Give the settled promise's continuations a turn.
				if (!closed && runtime.alive && runtime.hasPendingJob()) {
					const jobs = runtime.executePendingJobs();
					if ("error" in jobs && jobs.error) jobs.error.dispose();
				}
			});
			return deferred.handle;
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
		const prelude = ctx.evalCode(preludeSource(Object.keys(tools), options.allTools ?? []), "prelude.js");
		if (prelude.error) {
			const error = formatError(ctx.dump(prelude.error));
			prelude.error.dispose();
			disposeIsolate();
			return finish({ status: "error", error, emitted });
		}
		prelude.value.dispose();

		// --- the cell itself: ES module for top-level await ---
		const evaluated = ctx.evalCode(source, "cell.mjs", { type: "module" });
		if (evaluated.error) {
			const error = formatError(ctx.dump(evaluated.error));
			evaluated.error.dispose();
			const status = classify(error);
			disposeIsolate();
			return finish(status === "exit" ? { status: "ok", emitted } : { status, error, emitted });
		}

		// Module completion is a promise; pump pending jobs until it settles.
		const completion = evaluated.value;
		let settled: { error?: CodeCellError } | null = null;
		void ctx.resolvePromise(completion).then((result) => {
			if (closed) return;
			if ("error" in result && result.error) {
				const error = formatError(ctx.dump(result.error));
				result.error.dispose();
				settled = { error };
			} else {
				if ("value" in result) result.value.dispose();
				settled = {};
			}
		});
		while (settled === null) {
			const aborted = options.abortSignal?.aborted === true;
			if (Date.now() > deadline || aborted) {
				interrupted = true;
				hostAbort.abort(new Error(aborted ? "Execution aborted." : "Execution deadline exceeded."));
				completion.dispose();
				disposeIsolate();
				return finish({
					status: aborted ? "error" : "timeout",
					error: aborted
						? { name: "AbortError", message: "Execution aborted." }
						: { name: "TimeoutError", message: `Execution exceeded ${timeoutMs}ms.` },
					emitted,
				});
			}
			if (runtime.hasPendingJob()) {
				const jobs = runtime.executePendingJobs();
				if ("error" in jobs && jobs.error) jobs.error.dispose();
			}
			// Macrotask turn so host promises and resolvePromise continuations
			// can advance while the VM is idle.
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
		}
		completion.dispose();

		const failure = (settled as { error?: CodeCellError }).error;
		if (failure) {
			const status = classify(failure);
			disposeIsolate();
			return finish(status === "exit" ? { status: "ok", emitted } : { status, error: failure, emitted });
		}
		disposeIsolate();
		return finish({ status: "ok", emitted });
	} catch (error) {
		// Engine-level throw (never a script error): classify conservatively.
		const formatted: CodeCellError =
			error instanceof Error ? { name: error.name || "Error", message: error.message } : { name: "Error", message: String(error) };
		disposeIsolate();
		return finish({ status: interrupted ? "timeout" : "error", error: formatted, emitted });
	} finally {
		if (!hostAbort.signal.aborted && closed) {
			// Belt-and-braces: no host work may outlive the cell unnoticed.
			hostAbort.abort(new Error("Code cell finished."));
		}
	}
}
