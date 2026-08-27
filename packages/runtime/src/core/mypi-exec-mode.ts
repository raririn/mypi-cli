/**
 * Per-session execution mode (MyPi).
 *
 * MyPi's shell-safety controls used to be two independent, differently-scoped
 * toggles: an OS `/sandbox` backed by a global preference file, and a
 * process-local `/safemode` approval gate. Users want one per-session control.
 *
 * A hosted session is served by its own `mypi --mode rpc` engine process, so a
 * process-local value here is naturally per-session. This module owns that
 * value as a single three-way mode and is the one place the bash tool, the
 * safe-mode gate, and the footer indicator consult:
 *
 *   off      normal: no OS isolation, no approval gate (default)
 *   sandbox  OS sandbox wraps bash/`!` execution
 *   safe     mutating tools require approval; no OS isolation
 *
 * The three are mutually exclusive. The value starts at "off" and only the
 * per-session hotkey/command changes it in memory; the persistent operator
 * default lives in shared.safety.defaultMode and is enforced by the runtime
 * safety ladder, not by this compat module.
 */

export type ExecutionMode = "off" | "sandbox" | "safe";

export const EXECUTION_MODE_CYCLE: readonly ExecutionMode[] = ["off", "sandbox", "safe"];

let current: ExecutionMode | undefined;
const listeners = new Set<(mode: ExecutionMode) => void>();

export function getExecutionMode(): ExecutionMode {
	// No global seed: the legacy sandbox-config.json preference was migrated
	// into shared.safety.defaultMode, which the runtime safety ladder (not
	// this compat module) enforces per session. This mode only changes via
	// the explicit /sandbox and /safemode toggles.
	if (current === undefined) current = "off";
	return current;
}

export function setExecutionMode(mode: ExecutionMode): ExecutionMode {
	const next = mode === "sandbox" || mode === "safe" ? mode : "off";
	if (current === next) return next;
	current = next;
	for (const listener of [...listeners]) {
		try {
			listener(next);
		} catch {
			// A misbehaving listener must not break mode changes.
		}
	}
	return next;
}

/** Advance to the next mode in the cycle order and return it. */
export function cycleExecutionMode(): ExecutionMode {
	const index = EXECUTION_MODE_CYCLE.indexOf(getExecutionMode());
	const next = EXECUTION_MODE_CYCLE[(index + 1) % EXECUTION_MODE_CYCLE.length]!;
	return setExecutionMode(next);
}

export function isSandboxActive(): boolean {
	return getExecutionMode() === "sandbox";
}

export function isSafeModeActive(): boolean {
	return getExecutionMode() === "safe";
}

/** Subscribe to mode changes; returns an unsubscribe function. */
export function onExecutionModeChange(listener: (mode: ExecutionMode) => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Test-only reset of the process-local state. */
export function __resetExecutionModeForTest(): void {
	current = undefined;
	listeners.clear();
}
