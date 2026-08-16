import { CONFIG_DIR_NAME } from "../config.ts";
import { emitProjectTrustEvent } from "./extensions/runner.ts";
import type { LoadExtensionsResult, ProjectTrustContext } from "./extensions/types.ts";
import type { DefaultProjectTrust } from "./settings-manager.ts";
import {
	getProjectTrustOptions,
	resolveProjectTrustRoot,
	type ProjectTrustOption,
	type ProjectTrustStore,
} from "./trust-manager.ts";

export type AppMode = "interactive" | "print" | "json" | "rpc";

export interface ResolveProjectTrustedOptions {
	cwd: string;
	trustStore: ProjectTrustStore;
	trustOverride?: boolean;
	defaultProjectTrust?: DefaultProjectTrust;
	extensionsResult?: LoadExtensionsResult;
	projectTrustContext: ProjectTrustContext;
	onExtensionError?: (message: string) => void;
}

export class ProjectTrustDeclinedError extends Error {
	readonly trustRoot: string;

	constructor(trustRoot: string) {
		super(`Workspace trust was declined for ${trustRoot}`);
		this.name = "ProjectTrustDeclinedError";
		this.trustRoot = trustRoot;
	}
}

function formatProjectTrustPrompt(cwd: string): string {
	return `Do you trust this workspace?\n${cwd}\n\nThe agent can read and overwrite files inside this workspace. Agents may perform destructive action in the workspace even in sandbox.\n\nTrusting also allows MyPi to load ${CONFIG_DIR_NAME} settings, instructions, extensions, skills, prompts, and themes, and to install missing project packages.`;
}

async function selectProjectTrustOption(
	cwd: string,
	ctx: ProjectTrustContext,
): Promise<ProjectTrustOption | undefined> {
	const options = getProjectTrustOptions(cwd, { includeSessionOnly: true }).filter((option) => option.trusted);
	const selected = await ctx.ui.select(
		formatProjectTrustPrompt(cwd),
		[...options.map((option) => option.label), "Cancel"],
	);
	return options.find((option) => option.label === selected);
}

function saveProjectTrustPromptResult(trustStore: ProjectTrustStore, result: ProjectTrustOption): void {
	if (result.updates.length > 0) {
		trustStore.setMany(result.updates);
	}
}

export async function resolveProjectTrusted(options: ResolveProjectTrustedOptions): Promise<boolean> {
	if (options.trustOverride !== undefined) {
		return options.trustOverride;
	}
	const trustRoot = resolveProjectTrustRoot(options.cwd);

	if (options.extensionsResult) {
		const { result, errors } = await emitProjectTrustEvent(
			options.extensionsResult,
			{ type: "project_trust", cwd: trustRoot },
			options.projectTrustContext,
		);
		for (const error of errors) {
			options.onExtensionError?.(`Extension "${error.extensionPath}" project_trust error: ${error.error}`);
		}
		if (result) {
			const trusted = result.trusted === "yes";
			if (result.remember === true) {
				options.trustStore.set(trustRoot, trusted);
			}
			if (!trusted && options.projectTrustContext.hasUI) throw new ProjectTrustDeclinedError(trustRoot);
			return trusted;
		}
	}

	const decision = options.trustStore.get(trustRoot);
	if (decision === true) return true;
	if (decision === false) {
		if (options.projectTrustContext.hasUI) throw new ProjectTrustDeclinedError(trustRoot);
		return false;
	}

	if (!options.projectTrustContext.hasUI) {
		return false;
	}

	const selected = await selectProjectTrustOption(trustRoot, options.projectTrustContext);
	if (selected !== undefined) {
		saveProjectTrustPromptResult(options.trustStore, selected);
		return selected.trusted;
	}
	throw new ProjectTrustDeclinedError(trustRoot);
}
