import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Optional Brave API configuration for MyPi's built-in web search. */
export interface BraveSearchConfig {
	version: 1;
	apiKey: string;
	defaultCountry: string;
}

export type WebSearchProviderPreference = "brave" | "curl";

/** Host-local provider preference for MyPi's built-in web search. */
export interface WebSearchPreferenceConfig {
	version: 1;
	provider: WebSearchProviderPreference;
}

export const DEFAULT_WEB_SEARCH_PREFERENCE: WebSearchPreferenceConfig = {
	version: 1,
	provider: "brave",
};

export function braveSearchConfigPath(agentDir: string): string {
	return resolve(agentDir, "brave-search.json");
}

export function webSearchPreferenceConfigPath(agentDir: string): string {
	return resolve(agentDir, "websearch-config.json");
}

export function resolveWebSearchPreference(agentDir: string): WebSearchPreferenceConfig {
	const path = webSearchPreferenceConfigPath(agentDir);
	if (!existsSync(path)) {
		return { ...DEFAULT_WEB_SEARCH_PREFERENCE };
	}

	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink()) {
		throw new Error(`Refusing unsafe web-search preference at ${path}: expected a regular non-symlinked file.`);
	}

	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw new Error(`Could not parse web-search preference at ${path}; expected valid JSON.`);
	}

	if (!value || typeof value !== "object") {
		throw new Error(`Invalid web-search preference at ${path}.`);
	}
	const candidate = value as { version?: unknown; provider?: unknown };
	if (candidate.version !== 1 || (candidate.provider !== "brave" && candidate.provider !== "curl")) {
		throw new Error(`Invalid web-search preference at ${path}; expected version 1 and provider "brave" or "curl".`);
	}

	return { version: 1, provider: candidate.provider };
}

export function saveWebSearchPreference(agentDir: string, provider: WebSearchProviderPreference): void {
	if (provider !== "brave" && provider !== "curl") {
		throw new Error('Invalid web-search provider; expected "brave" or "curl".');
	}
	const root = resolve(agentDir);
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const rootStat = lstatSync(root);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
		throw new Error(`Refusing unsafe MyPi agent directory at ${root}: expected a non-symlinked directory.`);
	}

	const path = webSearchPreferenceConfigPath(root);
	if (existsSync(path)) {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink()) {
			throw new Error(`Refusing unsafe web-search preference at ${path}: expected a regular non-symlinked file.`);
		}
	}

	const temporaryPath = `${path}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
	let descriptor: number | undefined;
	try {
		descriptor = openSync(temporaryPath, "wx", 0o600);
		writeFileSync(descriptor, `${JSON.stringify({ version: 1, provider }, null, 2)}\n`, "utf8");
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		chmodSync(temporaryPath, 0o600);
		renameSync(temporaryPath, path);
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
		rmSync(temporaryPath, { force: true });
	}
}

export function resolveBraveSearchConfig(
	agentDir: string,
	env: NodeJS.ProcessEnv = process.env,
): BraveSearchConfig | undefined {
	const environmentKey = env.BRAVE_API_KEY?.trim();
	if (environmentKey) {
		return { version: 1, apiKey: environmentKey, defaultCountry: "US" };
	}

	const path = braveSearchConfigPath(agentDir);
	if (!existsSync(path)) {
		return undefined;
	}

	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink()) {
		throw new Error(`Refusing unsafe Brave Search config at ${path}: expected a regular non-symlinked file.`);
	}
	if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
		throw new Error(`Refusing unsafe Brave Search config permissions at ${path}; run chmod 600 ${path}.`);
	}

	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw new Error(`Could not parse Brave Search config at ${path}; expected valid JSON.`);
	}

	if (!value || typeof value !== "object") {
		throw new Error(`Invalid Brave Search config at ${path}.`);
	}
	const candidate = value as { version?: unknown; apiKey?: unknown; defaultCountry?: unknown };
	const apiKey = typeof candidate.apiKey === "string" ? candidate.apiKey.trim() : "";
	const defaultCountry =
		typeof candidate.defaultCountry === "string" ? candidate.defaultCountry.trim().toUpperCase() : "US";
	if (candidate.version !== 1 || !apiKey || !/^[A-Z]{2}$/.test(defaultCountry)) {
		throw new Error(
			`Invalid Brave Search config at ${path}; expected version 1, apiKey, and a two-letter defaultCountry.`,
		);
	}

	return { version: 1, apiKey, defaultCountry };
}

export async function resolveAgentDir(): Promise<string> {
	return process.env.MYPI_AGENT_DIR || process.env.MYPI_CODING_AGENT_DIR
		? resolve(process.env.MYPI_AGENT_DIR || process.env.MYPI_CODING_AGENT_DIR!)
		: join(homedir(), ".mypi", "agent");
}
