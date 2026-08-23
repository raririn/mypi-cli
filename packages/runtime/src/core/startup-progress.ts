import { appendFileSync, mkdirSync, statSync, truncateSync } from "node:fs";
import { dirname } from "node:path";

interface StartupProgressBridge {
	mark(stage: string, message?: string): void;
	finish(stage?: string): void;
}

interface StartupEvent {
	readonly stage: string;
	readonly elapsedMs: number;
	readonly deltaMs: number;
}

let childBridge: StartupProgressBridge | undefined;

function inheritedBridge(): StartupProgressBridge | undefined {
	if (childBridge) return childBridge;
	const startedAt = Number(process.env.MYPI_STARTUP_STARTED_AT);
	const logPath = process.env.MYPI_STARTUP_LOG;
	if (!Number.isFinite(startedAt) || !logPath || !process.stderr.isTTY) return undefined;
	let events: StartupEvent[] = [];
	try {
		const parsed = JSON.parse(process.env.MYPI_STARTUP_EVENTS ?? "[]") as unknown;
		if (Array.isArray(parsed)) events = parsed as StartupEvent[];
	} catch {}
	let previousElapsed = events.at(-1)?.elapsedMs ?? 0;
	let finished = false;
	const render = (message: string) => process.stderr.write(`\r\x1b[2K${message}`);
	childBridge = {
		mark(stage, message) {
			const elapsedMs = Math.max(0, Date.now() - startedAt);
			events.push({ stage, elapsedMs, deltaMs: Math.max(0, elapsedMs - previousElapsed) });
			previousElapsed = elapsedMs;
			process.env.MYPI_STARTUP_EVENTS = JSON.stringify(events);
			if (message) render(message);
		},
		finish(stage = "main-interface-first-frame") {
			if (finished) return;
			finished = true;
			this.mark(stage);
			try {
				mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
				try {
					if (statSync(logPath).size > 1024 * 1024) truncateSync(logPath, 0);
				} catch {}
				appendFileSync(logPath, `${JSON.stringify({
					version: process.env.MYPI_STARTUP_VERSION ?? null,
					pid: process.pid,
					at: new Date().toISOString(),
					events,
				})}\n`, { mode: 0o600 });
			} catch {}
		},
	};
	return childBridge;
}

function bridge(): StartupProgressBridge | undefined {
	return (globalThis as typeof globalThis & { __MYPI_STARTUP_PROGRESS__?: StartupProgressBridge })
		.__MYPI_STARTUP_PROGRESS__ ?? inheritedBridge();
}

/** Launcher-owned, best-effort startup feedback. It is absent for library,
 * RPC, print, and test entry points, so calls here are deliberately no-ops. */
export function markStartupProgress(stage: string, message?: string): void {
	bridge()?.mark(stage, message);
}

export function finishStartupProgress(stage?: string): void {
	bridge()?.finish(stage);
}
