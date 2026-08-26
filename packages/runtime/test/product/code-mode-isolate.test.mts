/*
 * FEAT-087 Phase 1 acceptance + pressure suite for the Code Mode isolate
 * (spec R1 hermetic execution, R6 timeout/memory bounds, R7 error
 * propagation, plus the R5/R8 primitives text()/store()/load()).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { runCodeCell } from "../../src/core/code-mode/isolate.ts";

// ---------------------------------------------------------------- functional

test("emits curated text output; return values are discarded", async () => {
	const result = await runCodeCell(`
		text("first");
		text("second");
		"this completion value must not appear anywhere";
	`);
	assert.equal(result.status, "ok");
	assert.deepEqual(result.emitted, [
		{ type: "text", text: "first" },
		{ type: "text", text: "second" },
	]);
});

test("bridges async tools with JSON-only marshalling", async () => {
	const seen: unknown[] = [];
	const result = await runCodeCell(
		`
		const a = await tools.read({ path: "a.txt", limit: 3 });
		const b = await tools.read({ path: "b.txt" });
		text(a.output + "|" + b.output);
		`,
		{
			tools: {
				read: async (args) => {
					seen.push(args);
					await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
					return { output: `<${(args as { path: string }).path}>` };
				},
			},
		},
	);
	assert.equal(result.status, "ok", result.error?.message);
	assert.deepEqual(result.emitted, [{ type: "text", text: "<a.txt>|<b.txt>" }]);
	assert.deepEqual(seen, [{ path: "a.txt", limit: 3 }, { path: "b.txt" }]);
});

test("host tool failures surface as catchable in-script exceptions", async () => {
	const result = await runCodeCell(
		`
		try {
			await tools.deny({});
		} catch (error) {
			text("caught:" + error.name + ":" + error.message);
		}
		`,
		{
			tools: {
				deny: async () => {
					const error = new Error("Permission denied by safety policy.");
					error.name = "PermissionDenied";
					throw error;
				},
			},
		},
	);
	assert.equal(result.status, "ok");
	assert.deepEqual(result.emitted, [{ type: "text", text: "caught:PermissionDenied:Permission denied by safety policy." }]);
});

test("uncaught tool failure fails the cell with the host message", async () => {
	const result = await runCodeCell(`await tools.deny({});`, {
		tools: { deny: async () => { throw new Error("nope"); } },
	});
	assert.equal(result.status, "error");
	assert.match(result.error!.message, /nope/);
});

test("unknown tool name is a structured error", async () => {
	const result = await runCodeCell(`await tools.read({});`, { tools: {} });
	assert.equal(result.status, "error");
	assert.match(result.error!.message, /not a function|Unknown tool/);
});

test("store/load scratchpad persists across cells via shared map", async () => {
	const scratchpad = new Map<string, unknown>();
	const first = await runCodeCell(`store("files", ["a.ts", "b.ts"]); store("count", 2);`, { scratchpad });
	assert.equal(first.status, "ok");
	const second = await runCodeCell(`const f = load("files"); text(f.join(",") + ":" + load("count") + ":" + load("missing"));`, { scratchpad });
	assert.equal(second.status, "ok");
	assert.deepEqual(second.emitted, [{ type: "text", text: "a.ts,b.ts:2:null" }]);
});

test("exit() ends the cell early and keeps prior output", async () => {
	const result = await runCodeCell(`text("kept"); exit(); text("never");`);
	assert.equal(result.status, "ok");
	assert.deepEqual(result.emitted, [{ type: "text", text: "kept" }]);
});

test("errors carry name, message and cell line context", async () => {
	const result = await runCodeCell(`const x = 1;\nnull.foo;`);
	assert.equal(result.status, "error");
	assert.equal(result.error!.name, "TypeError");
	assert.match(result.error!.stack ?? "", /cell\.mjs:2/);
});

test("pure-JS top-level awaits complete (pending-job pump)", async () => {
	const result = await runCodeCell(`
		const value = await Promise.resolve(21).then((n) => n * 2);
		await new Promise((resolvePromise) => resolvePromise());
		text("value:" + value);
	`);
	assert.equal(result.status, "ok", result.error?.message);
	assert.deepEqual(result.emitted, [{ type: "text", text: "value:42" }]);
});

test("each cell gets a fresh isolate — no global leakage between cells", async () => {
	await runCodeCell(`globalThis.leak = "boo";`);
	const result = await runCodeCell(`text(typeof globalThis.leak);`);
	assert.deepEqual(result.emitted, [{ type: "text", text: "undefined" }]);
});

test("concurrent cells run independently", async () => {
	const [a, b] = await Promise.all([
		runCodeCell(`text("A" + (await tools.t({})).v);`, { tools: { t: async () => ({ v: 1 }) } }),
		runCodeCell(`text("B" + (await tools.t({})).v);`, { tools: { t: async () => ({ v: 2 }) } }),
	]);
	assert.deepEqual(a.emitted, [{ type: "text", text: "A1" }]);
	assert.deepEqual(b.emitted, [{ type: "text", text: "B2" }]);
});

// ------------------------------------------------------- hermeticity (R1)

test("R1: no ambient Node globals reachable", async () => {
	const result = await runCodeCell(`
		text([
			typeof process, typeof require, typeof console, typeof fetch,
			typeof setTimeout, typeof setInterval, typeof Buffer, typeof WebAssembly,
		].join(","));
	`);
	assert.equal(result.status, "ok");
	// QuickJS ships no WebAssembly global either — nothing embeds a second VM.
	assert.deepEqual(result.emitted, [{ type: "text", text: "undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined" }]);
});

test("R1: static and dynamic imports are rejected", async () => {
	const stat = await runCodeCell(`import fs from "node:fs";`);
	assert.equal(stat.status, "error");
	const dyn = await runCodeCell(`await import("node:fs");`);
	assert.equal(dyn.status, "error");
});

test("R1: prototype-chain walks stay inside the isolate", async () => {
	const result = await runCodeCell(
		`
		const escapes = [];
		const g1 = tools.probe.constructor("return globalThis")();
		escapes.push(typeof g1.process, typeof g1.__host_invoke);
		const g2 = (async () => {}).constructor("return globalThis")();
		escapes.push(typeof g2.process);
		escapes.push(typeof globalThis.__host_invoke, typeof globalThis.__host_emit);
		text(escapes.join(","));
		`,
		{ tools: { probe: async () => null } },
	);
	assert.equal(result.status, "ok", result.error?.message);
	// Every escape route lands back in the isolate's own global — which has
	// no process and no host primitives (the prelude deleted them).
	assert.deepEqual(result.emitted, [{ type: "text", text: "undefined,undefined,undefined,undefined,undefined" }]);
});

test("R1: the membrane is data-only — host receives plain JSON", async () => {
	let received: unknown;
	const result = await runCodeCell(
		`await tools.sink({ fn: () => 1, nested: { n: 1 }, arr: [1, "x"] });`,
		{ tools: { sink: async (args) => { received = args; return null; } } },
	);
	assert.equal(result.status, "ok");
	// Functions do not survive JSON marshalling; data does.
	assert.deepEqual(received, { nested: { n: 1 }, arr: [1, "x"] });
});

// --------------------------------------------------- bounds/pressure (R6)

test("R6: synchronous infinite loop is interrupted as timeout", async () => {
	const started = Date.now();
	const result = await runCodeCell(`while (true) {}`, { timeoutMs: 400 });
	assert.equal(result.status, "timeout");
	assert.ok(Date.now() - started < 5_000);
});

test("R6: infinite loop AFTER a pure-JS await is still interrupted", async () => {
	const result = await runCodeCell(`await Promise.resolve(); while (true) {}`, { timeoutMs: 400 });
	assert.equal(result.status, "timeout");
});

test("R6: infinite loop after a HOST await is still interrupted", async () => {
	const result = await runCodeCell(`await tools.t({}); while (true) {}`, {
		timeoutMs: 500,
		tools: { t: async () => null },
	});
	assert.equal(result.status, "timeout");
});

test("R6: a host call that never resolves times out at the wall clock", async () => {
	const result = await runCodeCell(`await tools.hang({});`, {
		timeoutMs: 400,
		tools: { hang: () => new Promise(() => undefined) },
	});
	assert.equal(result.status, "timeout");
});

test("R6: an oversized allocation hits the memory limit, not the host", async () => {
	const result = await runCodeCell(`const b = new ArrayBuffer(64 * 1024 * 1024);`, {
		memoryLimitBytes: 16 * 1024 * 1024,
		timeoutMs: 5_000,
	});
	assert.equal(result.status, "memory");
	assert.match(result.error!.message, /out of memory/i);
});

test("R6: exponential string growth is a contained error", async () => {
	const result = await runCodeCell(`let s = "x"; for (let i = 0; i < 40; i += 1) s += s;`, {
		memoryLimitBytes: 16 * 1024 * 1024,
		timeoutMs: 5_000,
	});
	assert.equal(result.status, "error");
	assert.match(result.error!.message, /string too long|out of memory/i);
});

test("R6: allocation-thrash near the limit still terminates (timeout backstop)", async () => {
	// String-heavy allocation can GC-thrash below the hard OOM threshold; the
	// wall clock is the backstop and either classification is a contained end.
	const result = await runCodeCell(`const a = []; for (;;) a.push(new Array(65536).fill("x"));`, {
		memoryLimitBytes: 16 * 1024 * 1024,
		timeoutMs: 4_000,
	});
	assert.ok(result.status === "memory" || result.status === "timeout", result.status);
});

test("R6: runaway recursion is contained INSIDE the isolate", async () => {
	const result = await runCodeCell(`const f = () => f(); f();`, { timeoutMs: 5_000 });
	assert.equal(result.status, "error");
	// QuickJS must throw its own overflow — a host RangeError here means the
	// stack budget is dangerously large (see DEFAULT_MAX_STACK_BYTES note).
	assert.match(result.error!.message, /stack overflow/i);
});

test("R6: emit budget is enforced and catchable", async () => {
	const result = await runCodeCell(
		`
		let count = 0;
		try {
			for (;;) { text("x".repeat(1024)); count += 1; }
		} catch (error) {
			// budget error is catchable; prior output survives
		}
		`,
		{ maxEmittedItems: 8 },
	);
	assert.equal(result.status, "ok");
	assert.equal(result.emitted.length, 8);
});

test("R6: scratchpad budget is enforced", async () => {
	const result = await runCodeCell(`store("big", "y".repeat(1024 * 1024));`, { maxScratchpadBytes: 1024 });
	assert.equal(result.status, "error");
	assert.match(result.error!.message, /Scratchpad budget/);
});

test("pressure: many sequential cells do not leak isolates", async () => {
	for (let index = 0; index < 25; index += 1) {
		const result = await runCodeCell(`text("cell-${""}" + ${index});`);
		assert.equal(result.status, "ok");
	}
});

test("documented limitation: asyncify serializes concurrent host awaits inside one cell", async () => {
	// Promise.all over tools.* does NOT run host calls concurrently under the
	// asyncify build — the whole VM suspends per host call. Phase 2 provides a
	// host-side parallel primitive instead. This test pins the behavior so a
	// future engine change is noticed.
	const started = Date.now();
	const result = await runCodeCell(
		`await Promise.all([tools.slow({}), tools.slow({})]); text("done");`,
		{ tools: { slow: async () => { await new Promise((resolvePromise) => setTimeout(resolvePromise, 120)); return null; } } },
	);
	assert.equal(result.status, "ok", result.error?.message);
	assert.ok(Date.now() - started >= 200, "expected serialized host awaits (~240ms)");
});
