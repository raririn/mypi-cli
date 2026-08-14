/**
 * Daemon-backed `InteractiveRuntimeHost` (FEAT-061 Phase B).
 *
 * Session replacement flows (new, fork, resume, import) become routed RPC
 * commands; the engine replaces its session in place and the daemon
 * re-broadcasts the new identity to every surface. Disposal detaches — the
 * session keeps running in the daemon, which is the point.
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { resolvePath } from "../../utils/paths.ts";
import type {
	InteractiveRuntimeHost,
	InteractiveSessionSurface,
} from "../agent-session-runtime.ts";
import { SessionImportFileNotFoundError } from "../agent-session-runtime.ts";
import type { AgentSessionServices } from "../agent-session-services.ts";
import { getMissingSessionCwdIssue, MissingSessionCwdError } from "../session-cwd.ts";
import { SessionManager } from "../session-manager.ts";
import { HostedDaemonClient, readHostedDaemonEnv } from "./daemon-client.ts";
import { HostedAgentSession, HostedStateMirror } from "./hosted-session.ts";

export class HostedRuntimeHost implements InteractiveRuntimeHost {
	readonly session: HostedAgentSession;
	readonly services: AgentSessionServices;
	private readonly client: HostedDaemonClient;
	private rebindSession?: (session: InteractiveSessionSurface) => Promise<void>;
	private beforeSessionInvalidate?: () => void;

	constructor(client: HostedDaemonClient, services: AgentSessionServices, session: HostedAgentSession) {
		this.client = client;
		this.services = services;
		this.session = session;
		// Another surface replaced the child's session: mirror is already
		// re-seeded, so re-render against the new target.
		this.session.onIdentityChanged(() => {
			void this.finishReplacement();
		});
	}

	/** The running daemon's product version (from its handshake), or null on an
	 *  older daemon that predates version reporting. */
	get daemonVersion(): string | null {
		return this.client.daemonVersion;
	}

	setRebindSession(rebindSession?: (session: InteractiveSessionSurface) => Promise<void>): void {
		this.rebindSession = rebindSession;
	}

	setBeforeSessionInvalidate(beforeSessionInvalidate?: () => void): void {
		this.beforeSessionInvalidate = beforeSessionInvalidate;
	}

	private async finishReplacement(): Promise<void> {
		this.beforeSessionInvalidate?.();
		if (this.rebindSession) {
			await this.rebindSession(this.session);
		}
	}

	private async replace<T extends { cancelled: boolean }>(run: () => Promise<T>): Promise<T> {
		this.session.replacementInFlight = true;
		try {
			const adoption = this.session.waitForNextAttached();
			const result = await run();
			if (result.cancelled) return result;
			// The daemon re-learns the child's identity after the command; wait
			// for the re-broadcast so the mirror seeds against the new target.
			await adoption;
			await this.session.seed();
			await this.finishReplacement();
			return result;
		} finally {
			this.session.replacementInFlight = false;
		}
	}

	async newSession(options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		withSession?: unknown;
	}): Promise<{ cancelled: boolean }> {
		return this.replace(async () => {
			const response = await this.client.request<{ data: { cancelled: boolean } }>({
				type: "new_session",
				parentSession: options?.parentSession,
			});
			return { cancelled: response.data.cancelled };
		});
	}

	async fork(
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: unknown },
	): Promise<{ cancelled: boolean; selectedText?: string }> {
		return this.replace(async () => {
			const response = await this.client.request<{ data: { text?: string; cancelled: boolean } }>({
				type: "fork",
				entryId,
				position: options?.position,
			});
			return { cancelled: response.data.cancelled, selectedText: response.data.text };
		});
	}

	async switchSession(
		sessionPath: string,
		options?: {
			cwdOverride?: string;
			withSession?: unknown;
			projectTrustContextFactory?: unknown;
		},
	): Promise<{ cancelled: boolean }> {
		// The session file is local; check its stored cwd here so the TUI's
		// missing-cwd prompt flow behaves exactly as embedded.
		if (!options?.cwdOverride) {
			const target = SessionManager.open(resolvePath(sessionPath, process.cwd()));
			const issue = getMissingSessionCwdIssue(target, this.services.cwd);
			if (issue) throw new MissingSessionCwdError(issue);
		}
		return this.replace(async () => {
			const response = await this.client.request<{ data: { cancelled: boolean } }>({
				type: "switch_session",
				sessionPath: resolvePath(sessionPath, process.cwd()),
				cwdOverride: options?.cwdOverride,
			});
			return { cancelled: response.data.cancelled };
		});
	}

	async importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
		const resolvedPath = resolvePath(inputPath, process.cwd());
		if (!existsSync(resolvedPath)) {
			throw new SessionImportFileNotFoundError(resolvedPath);
		}
		const sessionDir = this.session.sessionManager.getSessionDir();
		if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });
		const destinationPath = join(sessionDir, basename(resolvedPath));
		if (resolve(destinationPath) !== resolvedPath) {
			copyFileSync(resolvedPath, destinationPath);
		}
		return this.switchSession(destinationPath, cwdOverride ? { cwdOverride } : undefined);
	}

	async dispose(): Promise<void> {
		this.beforeSessionInvalidate?.();
		this.client.detach();
		this.client.close();
	}
}

export interface CreateHostedRuntimeOptions {
	services: AgentSessionServices;
	/** Resume this session; omit to create a fresh one. */
	sessionId?: string;
	cwd: string;
	model?: string;
}

const HOSTED_ATTACH_RETRIES = 2;
const HOSTED_ATTACH_RETRY_DELAY_MS = 750;

/**
 * Dial the daemon the launcher pointed us at, attach (or create) the
 * session, seed the mirror, and hand back a runtime host the TUI can use.
 *
 * Connect/attach failures are retried a couple of times before giving up: a
 * transient daemon state (restarting, the target session's engine mid-spawn
 * or mid-turn) must not dump an eligible launch into the embedded runtime —
 * for a daemon-owned session, embedded can only lose the writer-lease check
 * afterwards, so riding out the blip here is strictly better.
 */
export async function createHostedRuntime(options: CreateHostedRuntimeOptions): Promise<HostedRuntimeHost> {
	const env = readHostedDaemonEnv();
	if (!env) {
		throw new Error("Hosted TUI requested without daemon coordinates (MYPI_DAEMON_SOCKET/MYPI_DAEMON_PROTOCOL).");
	}
	let lastError: unknown;
	for (let attempt = 0; attempt <= HOSTED_ATTACH_RETRIES; attempt += 1) {
		if (attempt > 0) {
			await new Promise((resolve) => setTimeout(resolve, HOSTED_ATTACH_RETRY_DELAY_MS * attempt));
		}
		const client = new HostedDaemonClient(env);
		try {
			await client.connect();
			const attached = await client.attach({
				sessionId: options.sessionId,
				cwd: options.cwd,
				model: options.model,
			});
			const mirror = new HostedStateMirror(attached.cwd);
			mirror.sessionId = attached.sessionId;
			mirror.sessionFile = attached.sessionFile ?? undefined;
			const session = new HostedAgentSession({ client, services: options.services, mirror });
			await session.seed();
			return new HostedRuntimeHost(client, options.services, session);
		} catch (error) {
			client.close();
			lastError = error;
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
