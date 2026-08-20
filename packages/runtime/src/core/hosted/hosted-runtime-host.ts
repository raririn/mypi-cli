/**
 * Daemon-backed `InteractiveRuntimeHost` (FEAT-061 Phase B).
 *
 * Session replacement flows are requester-local. New/fork prepare a distinct
 * persisted target and attach its daemon child; resume/import attach an
 * existing target child. In every case the target is ready before this one
 * surface leaves its source, so co-attached surfaces keep their session and a
 * failed target startup cannot strand the requester. Disposal detaches — the
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
import {
	HostedDaemonClient,
	HostedOwnershipConflictError,
	readHostedDaemonEnv,
	type HostedDaemonEnv,
	type HostedHandoffResult,
} from "./daemon-client.ts";
import { HostedAgentSession, HostedStateMirror } from "./hosted-session.ts";

export class HostedRuntimeHost implements InteractiveRuntimeHost {
	session: HostedAgentSession;
	readonly services: AgentSessionServices;
	private client: HostedDaemonClient;
	private readonly env: HostedDaemonEnv;
	private rebindSession?: (session: InteractiveSessionSurface) => Promise<void>;
	private beforeSessionInvalidate?: () => void;
	private stopIdentityListener?: () => void;

	constructor(
		client: HostedDaemonClient,
		services: AgentSessionServices,
		session: HostedAgentSession,
		env: HostedDaemonEnv,
	) {
		this.client = client;
		this.services = services;
		this.session = session;
		this.env = env;
		this.bindIdentityListener(session);
	}

	private bindIdentityListener(session: HostedAgentSession): void {
		this.stopIdentityListener?.();
		// Another surface replaced the child's session: mirror is already
		// re-seeded, so re-render against the new target.
		this.stopIdentityListener = session.onIdentityChanged(() => {
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

	private async stageTarget(options: {
		sessionId: string;
		cwd: string;
		sessionStart?: { reason: "new" | "fork"; previousSessionFile?: string };
	}): Promise<{ client: HostedDaemonClient; session: HostedAgentSession }> {
		const client = new HostedDaemonClient(this.env);
		try {
			await client.connect();
			const attached = await client.attach(options);
			const mirror = new HostedStateMirror(attached.cwd);
			mirror.sessionId = attached.sessionId;
			mirror.sessionFile = attached.sessionFile ?? undefined;
			const session = new HostedAgentSession({ client, services: this.services, mirror });
			await session.seed();
			return { client, session };
		} catch (error) {
			client.close();
			throw error;
		}
	}

	private async adoptStagedTarget(staged: {
		client: HostedDaemonClient;
		session: HostedAgentSession;
	}): Promise<void> {
		const sourceClient = this.client;
		const sourceSession = this.session;
		this.client = staged.client;
		this.session = staged.session;
		this.bindIdentityListener(staged.session);
		try {
			await this.finishReplacement();
		} catch (error) {
			// Presentation failed after the target was ready. The source is still
			// attached, so restore it before releasing the speculative target.
			this.client = sourceClient;
			this.session = sourceSession;
			this.bindIdentityListener(sourceSession);
			staged.client.detach();
			staged.client.close();
			await this.finishReplacement().catch(() => {});
			throw error;
		}

		sourceClient.detach();
		sourceClient.close();
	}

	private async adoptPreparedTarget(
		target: SessionManager,
		reason: "new" | "fork",
		previousSessionFile?: string,
	): Promise<void> {
		const sessionFile = target.materialize();
		if (!sessionFile) throw new Error("A daemon-backed session target must be persisted before attach.");
		await this.adoptTargetInfo(
			{ sessionId: target.getSessionId(), sessionFile, cwd: target.getCwd() },
			reason,
			previousSessionFile,
		);
	}

	private async adoptTargetInfo(
		target: { sessionId: string; sessionFile: string; cwd: string },
		reason: "new" | "fork",
		previousSessionFile?: string,
	): Promise<void> {
		const staged = await this.stageTarget({
			sessionId: target.sessionId,
			cwd: target.cwd,
			sessionStart: {
				reason,
				...(previousSessionFile ? { previousSessionFile } : {}),
			},
		});
		await this.adoptStagedTarget(staged);
	}

	async newSession(options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		withSession?: unknown;
	}): Promise<{ cancelled: boolean }> {
		const source = this.session.sessionManager;
		if (!source.isPersisted()) {
			throw new Error("Daemon-backed /new requires a persisted source session.");
		}
		if (!options?.setup) {
			const response = await this.client.request<{
				data: {
					cancelled: boolean;
					target?: { sessionId: string; sessionFile: string; cwd: string };
				};
			}>({
				type: "prepare_surface_session",
				sourceSessionId: source.getSessionId(),
				operation: "new",
				...(options?.parentSession ? { parentSession: options.parentSession } : {}),
			});
			if (response.data.cancelled) return { cancelled: true };
			if (!response.data.target) throw new Error("The daemon did not return a prepared new-session target.");
			await this.adoptTargetInfo(response.data.target, "new", source.getSessionFile());
			return { cancelled: false };
		}

		// setup is an in-process callback and cannot cross the daemon wire. Keep
		// its established API by running preflight in the source engine, then
		// applying the callback to a requester-owned target before attach.
		const preflight = await this.client.request<{ data: { cancelled: boolean } }>({ type: "prepare_new_session" });
		if (preflight.data.cancelled) return { cancelled: true };
		const target = SessionManager.create(
			source.getCwd(),
			source.getSessionDir(),
			options?.parentSession ? { parentSession: options.parentSession } : undefined,
		);
		if (options?.setup) await options.setup(target);
		await this.adoptPreparedTarget(target, "new", source.getSessionFile());
		return { cancelled: false };
	}

	async fork(
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: unknown },
	): Promise<{ cancelled: boolean; selectedText?: string }> {
		const position = options?.position ?? "before";
		const response = await this.client.request<{
			data: {
				text?: string;
				cancelled: boolean;
				target?: { sessionId: string; sessionFile: string; cwd: string };
			};
		}>({
			type: "prepare_surface_session",
			sourceSessionId: this.session.sessionManager.getSessionId(),
			operation: "fork",
			entryId,
			position,
		});
		if (response.data.cancelled) return { cancelled: true };
		if (!response.data.target) throw new Error("The daemon did not return a prepared fork target.");
		const sourceFile = this.session.sessionManager.getSessionFile();
		await this.adoptTargetInfo(response.data.target, "fork", sourceFile);
		return { cancelled: false, selectedText: response.data.text };
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
		const resolvedSessionPath = resolvePath(sessionPath, process.cwd());
		const target = SessionManager.open(resolvedSessionPath);
		if (!options?.cwdOverride) {
			const issue = getMissingSessionCwdIssue(target, this.services.cwd);
			if (issue) throw new MissingSessionCwdError(issue);
		}

		const targetSessionId = target.getSessionId();
		if (targetSessionId === this.session.sessionManager.getSessionId()) {
			return { cancelled: false };
		}

		// A hosted /resume moves this one surface between daemon children. It
		// must not ask the current shared child to replace its identity: doing so
		// moves every co-attached GUI/TUI client and collides when the target is
		// already live in another child. Attach and seed the target first so any
		// failure leaves the source connection and its UI completely intact.
		let staged: { client: HostedDaemonClient; session: HostedAgentSession };
		try {
			staged = await this.stageTarget({
				sessionId: targetSessionId,
				cwd: options?.cwdOverride ?? target.getCwd(),
			});
		} catch (error) {
			if (error instanceof HostedOwnershipConflictError) {
				error.bindHandoffRequester(async (force, hard, confirmationToken) => {
					const response = await this.client.request<{ data: HostedHandoffResult }>(
						{
							type: "request_handoff",
							targetSessionId,
							expectedOwnerId: error.conflict.owner.ownerId,
							force,
							hard,
							...(confirmationToken ? { confirmationToken } : {}),
						},
						{ timeoutMs: 90_000 },
					);
					return response.data;
				});
			}
			throw error;
		}
		await this.adoptStagedTarget(staged);
		return { cancelled: false };
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
		this.stopIdentityListener?.();
		this.stopIdentityListener = undefined;
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
			return new HostedRuntimeHost(client, options.services, session, env);
		} catch (error) {
			client.close();
			if (error instanceof HostedOwnershipConflictError) {
				error.bindHandoffRequester(async (force, hard, confirmationToken) => {
					const negotiationClient = new HostedDaemonClient(env);
					try {
						await negotiationClient.connect("mypi-startup");
						const response = await negotiationClient.request<{ data: HostedHandoffResult }>(
							{
								type: "request_handoff",
								targetSessionId: error.conflict.sessionId,
								expectedOwnerId: error.conflict.owner.ownerId,
								force,
								hard,
								...(confirmationToken ? { confirmationToken } : {}),
							},
							{ timeoutMs: 90_000 },
						);
						return response.data;
					} finally {
						negotiationClient.close();
					}
				});
				// Ownership is stable enough to require user action; retrying engine
				// startup would only reproduce the same refused writer lock.
				throw error;
			}
			lastError = error;
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
