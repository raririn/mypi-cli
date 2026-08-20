import chalk from "chalk";
import { hostname } from "node:os";
import { HostedOwnershipConflictError, type HostedHandoffResult } from "../core/hosted/daemon-client.ts";
import {
	canOfferRob,
	formatRequestHandoffPrompt,
	formatRobPrompt,
	formatSigkillPrompt,
} from "../core/hosted/ownership-conflict-ui.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { showStartupSelector } from "./startup-ui.ts";

async function request(
	error: HostedOwnershipConflictError,
	force: boolean,
	hard = false,
): Promise<HostedHandoffResult> {
	try {
		return await error.requestHandoff(force, hard);
	} catch (requestError) {
		return {
			status: "error",
			message: requestError instanceof Error ? requestError.message : String(requestError),
		};
	}
}

/**
 * Resolve an ownership conflict before InteractiveMode exists (for example,
 * startup `mypi --resume`). Returns true only when normal hosted attach should
 * be retried; cancel and every fail-closed outcome return false.
 */
export async function promptForStartupOwnershipConflict(
	error: HostedOwnershipConflictError,
	settingsManager: SettingsManager,
): Promise<boolean> {
	const owner = error.conflict.owner;
	const requestCopy = formatRequestHandoffPrompt(owner);
	const first = await showStartupSelector(settingsManager, requestCopy.title, [
		{ label: requestCopy.requestOption, value: "request" as const },
		{ label: requestCopy.cancelOption, value: "cancel" as const },
	]);
	if (first !== "request") {
		console.error(chalk.dim(`Resume cancelled. ${requestCopy.manualAdvice}`));
		return false;
	}

	let result = await request(error, false);
	if (result.status === "released") return true;
	if (result.status === "owner-changed" || !canOfferRob(owner, hostname())) {
		console.error(chalk.yellow(
			`Rob is unavailable because MyPi cannot verify the exact same-host owner identity. ${result.message ?? ""} ${requestCopy.manualAdvice}`.trim(),
		));
		return false;
	}

	const detail = result.message ?? `Clean handoff ended with status: ${result.status}.`;
	const robCopy = formatRobPrompt(owner, detail);
	const second = await showStartupSelector(settingsManager, robCopy.title, [
		{ label: robCopy.cancelOption, value: "cancel" as const },
		{ label: robCopy.robOption, value: "rob" as const },
	]);
	if (second !== "rob") {
		console.error(chalk.dim(`Resume cancelled. ${robCopy.manualAdvice}`));
		return false;
	}

	result = await request(error, true);
	if (result.status === "released") return true;
	if (result.status === "needs-sigkill") {
		const killCopy = formatSigkillPrompt(owner);
		const third = await showStartupSelector(settingsManager, `${killCopy.title}\n${killCopy.message}`, [
			{ label: `Cancel (recommended) — Manage ${killCopy.pidLabel} manually`, value: "cancel" as const },
			{ label: `Send SIGKILL — Immediately terminate ${killCopy.pidLabel}`, value: "kill" as const },
		]);
		if (third !== "kill") {
			console.error(chalk.dim(`SIGKILL cancelled. ${killCopy.manualAdvice}`));
			return false;
		}
		result = await request(error, true, true);
		if (result.status === "released") return true;
	}

	console.error(chalk.yellow(
		`Could not rob the session safely: ${result.message ?? result.status}. ${robCopy.manualAdvice}`,
	));
	return false;
}
