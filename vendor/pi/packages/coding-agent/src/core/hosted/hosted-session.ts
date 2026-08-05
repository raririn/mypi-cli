/**
 * Daemon-backed session facade for the hosted TUI (FEAT-061 Phase B).
 *
 * The TUI consumes `InteractiveSessionSurface` — the compiler-enforced subset
 * of `AgentSession` it actually touches. This module satisfies that surface
 * as a daemon client:
 *
 * - mutations become routed RPC commands
 * - synchronous getters are served by a state mirror fed from the engine's
 *   event stream (seeded by `get_state`/`get_messages`)
 * - transcript reads come from the session file, which the engine persists
 *   on the same machine; the file is re-parsed only when it changes
 * - local, file-backed services (settings, resources, models) stay local
 * - extension UI requests arriving as daemon frames are rendered through the
 *   TUI's own `ExtensionUIContext`, so a hosted prompt looks identical to an
 *   embedded one; the first surface to answer wins and the rest are told to
 *   drop the dialog
 *
 * Extensions execute inside the daemon's engine child. Interaction (dialogs,
 * commands, tools) crosses the wire; chrome (custom components, renderers,
 * shortcuts) degrades to the default rendering, exactly as RPC mode behaves
 * (supported-surface policy, docs/25).
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Agent, AgentMessage, AgentState, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import type { AssistantMessage, ImageContent, Model } from "@earendil-works/pi-ai/compat";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { resolvePath } from "../../utils/paths.ts";
import type {
	AgentSessionEvent,
	AgentSessionEventListener,
	ExtensionBindings,
	ModelCycleResult,
	PromptOptions,
	SessionStats,
} from "../agent-session.ts";
import type { AgentSessionServices } from "../agent-session-services.ts";
import type {
	InteractiveAgentSurface,
	InteractiveExtensionSurface,
	InteractiveSessionManagerSurface,
	InteractiveSessionSurface,
} from "../agent-session-runtime.ts";
import type { BashResult } from "../bash-executor.ts";
import { calculateContextTokens, estimateContextTokens } from "../compaction/index.ts";
import type { CompactionResult } from "../compaction/index.ts";
import type {
	ContextUsage,
	ExtensionUIContext,
	ResolvedCommand,
	ToolDefinition,
} from "../extensions/index.ts";
import { ModelRegistry } from "../model-registry.ts";
import type { RpcSessionState, RpcSlashCommand } from "../../modes/rpc/rpc-types.ts";
import {
	CURRENT_SESSION_VERSION,
	getLatestCompactionEntry,
	SessionManager,
	type SessionHeader,
} from "../session-manager.ts";
import { addUsageToTotals, createUsageTotals } from "../usage-totals.ts";
import { createAllToolDefinitions } from "../tools/index.ts";
import { bindHostedTuiChrome, runHostedResourceCommand } from "../../extensions/mypi/tui-hero/index.ts";
import type { HostedDaemonClient } from "./daemon-client.ts";

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];

type Frame = Record<string, unknown> & { type?: string };

/** Frame types that belong to the daemon protocol, not the engine stream. */
const NON_EVENT_FRAMES = new Set([
	"response",
	"attached",
	"detached",
	"sessions",
	"released",
	"release_denied",
	"session_released",
	"session_exit",
	"session_stderr",
	"session_raw",
	"error",
	"extension_ui_request",
	"extension_ui_resolved",
	"__connection_lost",
]);

/* ------------------------------------------------------------------ */
/*  State mirror                                                       */
/* ------------------------------------------------------------------ */

/**
 * Engine state mirrored client-side so the TUI's synchronous reads have an
 * answer. Seeded from `get_state` + `get_messages`, then maintained from the
 * event stream; a fresh `get_state` reconciles after every settle.
 */
export class HostedStateMirror {
	model: Model<any> | undefined;
	thinkingLevel: ThinkingLevel = "off";
	isStreaming = false;
	isCompacting = false;
	isBashRunning = false;
	isRetrying = false;
	retryAttempt = 0;
	autoRetryEnabled = true;
	autoCompactionEnabled = true;
	steeringMode: "all" | "one-at-a-time" = "all";
	followUpMode: "all" | "one-at-a-time" = "all";
	sessionId = "";
	sessionFile: string | undefined;
	sessionName: string | undefined;
	cwd: string;
	sessionDir = "";
	usesDefaultSessionDir = true;
	isPersisted = true;
	scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }> = [];
	steeringQueue: string[] = [];
	followUpQueue: string[] = [];
	messages: AgentMessage[] = [];
	streamingMessage: AgentMessage | undefined;
	systemPrompt = "";

	private idleWaiters: Array<() => void> = [];

	constructor(cwd: string) {
		this.cwd = cwd;
	}

	get isIdle(): boolean {
		return !this.isStreaming;
	}

	applyState(state: RpcSessionState): void {
		this.model = state.model;
		this.thinkingLevel = state.thinkingLevel;
		this.isStreaming = state.isStreaming;
		this.isCompacting = state.isCompacting;
		this.steeringMode = state.steeringMode;
		this.followUpMode = state.followUpMode;
		this.sessionFile = state.sessionFile;
		this.sessionId = state.sessionId;
		this.sessionName = state.sessionName;
		this.autoCompactionEnabled = state.autoCompactionEnabled;
		if (state.cwd) this.cwd = state.cwd;
		if (state.sessionDir !== undefined) this.sessionDir = state.sessionDir;
		if (state.usesDefaultSessionDir !== undefined) this.usesDefaultSessionDir = state.usesDefaultSessionDir;
		if (state.isPersisted !== undefined) this.isPersisted = state.isPersisted;
		if (state.scopedModels) this.scopedModels = state.scopedModels;
		if (state.retryAttempt !== undefined) this.retryAttempt = state.retryAttempt;
		if (state.isRetrying !== undefined) this.isRetrying = state.isRetrying;
		if (state.autoRetryEnabled !== undefined) this.autoRetryEnabled = state.autoRetryEnabled;
		if (state.isBashRunning !== undefined) this.isBashRunning = state.isBashRunning;
		if (state.steeringQueue) this.steeringQueue = state.steeringQueue;
		if (state.followUpQueue) this.followUpQueue = state.followUpQueue;
		if (!this.isStreaming) this.settleIdle();
	}

	applyEvent(event: AgentSessionEvent): void {
		switch (event.type) {
			case "agent_start":
				this.isStreaming = true;
				break;
			case "agent_settled":
				this.isStreaming = false;
				this.streamingMessage = undefined;
				this.settleIdle();
				break;
			case "message_start":
				if (event.message) this.streamingMessage = event.message as AgentMessage;
				break;
			case "message_update":
				if (event.message) this.streamingMessage = event.message as AgentMessage;
				break;
			case "message_end":
				if (event.message) {
					this.messages.push(event.message as AgentMessage);
					this.streamingMessage = undefined;
				}
				break;
			case "queue_update":
				this.steeringQueue = [...event.steering];
				this.followUpQueue = [...event.followUp];
				break;
			case "session_info_changed":
				this.sessionName = event.name;
				break;
			case "thinking_level_changed":
				this.thinkingLevel = event.level;
				break;
			case "model_changed":
				this.model = event.model;
				this.thinkingLevel = event.thinkingLevel;
				break;
			case "scoped_models_changed":
				this.scopedModels = [...event.scopedModels];
				break;
			case "compaction_start":
				this.isCompacting = true;
				break;
			case "compaction_end":
				this.isCompacting = false;
				break;
			case "auto_retry_start":
				this.isRetrying = true;
				this.retryAttempt = event.attempt;
				break;
			case "auto_retry_end":
				this.isRetrying = false;
				if (event.success) this.retryAttempt = 0;
				break;
			default:
				break;
		}
	}

	waitForIdle(): Promise<void> {
		if (this.isIdle) return Promise.resolve();
		return new Promise((resolve) => this.idleWaiters.push(resolve));
	}

	private settleIdle(): void {
		const waiters = this.idleWaiters;
		this.idleWaiters = [];
		for (const waiter of waiters) waiter();
	}
}

/* ------------------------------------------------------------------ */
/*  Session manager facade                                             */
/* ------------------------------------------------------------------ */

/**
 * Transcript reads are served from the session file the engine persists on
 * this machine — the same source CloudCLI tails — re-parsed only when the
 * file changes. Identity comes from the mirror; the one write on this
 * surface (labels) goes over the wire.
 */
class HostedSessionManager implements InteractiveSessionManagerSurface {
	private readonly mirror: HostedStateMirror;
	private readonly client: HostedDaemonClient;
	private cached: SessionManager | undefined;
	private cachedFile: string | undefined;
	private cachedStat: { size: number; mtimeMs: number } | undefined;

	constructor(mirror: HostedStateMirror, client: HostedDaemonClient) {
		this.mirror = mirror;
		this.client = client;
	}

	private materialize(): SessionManager {
		const file = this.mirror.sessionFile;
		if (!file || !existsSync(file)) {
			// A fresh session has no file until the engine writes its first
			// entry; an empty in-memory view is exactly what it looks like.
			if (!this.cached || this.cachedFile !== undefined) {
				this.cached = SessionManager.inMemory(this.mirror.cwd);
				this.cachedFile = undefined;
				this.cachedStat = undefined;
			}
			return this.cached;
		}
		const stat = statSync(file);
		if (
			this.cached &&
			this.cachedFile === file &&
			this.cachedStat &&
			this.cachedStat.size === stat.size &&
			this.cachedStat.mtimeMs === stat.mtimeMs
		) {
			return this.cached;
		}
		this.cached = SessionManager.open(file, this.mirror.sessionDir || undefined);
		this.cachedFile = file;
		this.cachedStat = { size: stat.size, mtimeMs: stat.mtimeMs };
		return this.cached;
	}

	getCwd(): string {
		return this.mirror.cwd;
	}
	getSessionId(): string {
		return this.mirror.sessionId;
	}
	getSessionFile(): string | undefined {
		return this.mirror.sessionFile;
	}
	getSessionDir(): string {
		return this.mirror.sessionDir;
	}
	getSessionName(): string | undefined {
		return this.mirror.sessionName;
	}
	isPersisted(): boolean {
		return this.mirror.isPersisted;
	}
	usesDefaultSessionDir(): boolean {
		return this.mirror.usesDefaultSessionDir;
	}

	getLeafId(): ReturnType<SessionManager["getLeafId"]> {
		return this.materialize().getLeafId();
	}
	getLeafEntry(): ReturnType<SessionManager["getLeafEntry"]> {
		return this.materialize().getLeafEntry();
	}
	getEntry(id: string): ReturnType<SessionManager["getEntry"]> {
		return this.materialize().getEntry(id);
	}
	getLabel(id: string): ReturnType<SessionManager["getLabel"]> {
		return this.materialize().getLabel(id);
	}
	getBranch(fromId?: string): ReturnType<SessionManager["getBranch"]> {
		return this.materialize().getBranch(fromId);
	}
	buildContextEntries(): ReturnType<SessionManager["buildContextEntries"]> {
		return this.materialize().buildContextEntries();
	}
	getHeader(): ReturnType<SessionManager["getHeader"]> {
		return this.materialize().getHeader();
	}
	getEntries(): ReturnType<SessionManager["getEntries"]> {
		return this.materialize().getEntries();
	}
	getTree(): ReturnType<SessionManager["getTree"]> {
		return this.materialize().getTree();
	}

	appendLabelChange(targetId: string, label: string | undefined): string {
		// The engine owns the write; the call site does not consume the entry
		// id, so the wire round-trip is not worth blocking a sync surface on.
		this.client.sendCommand({ type: "append_label_change", targetId, label });
		return targetId;
	}
}

/* ------------------------------------------------------------------ */
/*  Extension surface facade                                           */
/* ------------------------------------------------------------------ */

/**
 * Extension metadata for the hosted TUI. Commands come from the engine over
 * `get_commands` (they execute engine-side when sent as prompt text);
 * renderers and shortcuts are chrome and degrade to the defaults.
 */
class HostedExtensionSurface implements InteractiveExtensionSurface {
	private commands: ResolvedCommand[] = [];
	private readonly registry: ModelRegistry;

	constructor(services: AgentSessionServices) {
		this.registry = new ModelRegistry(services.modelRuntime);
	}

	adoptCommands(commands: RpcSlashCommand[]): void {
		this.commands = commands
			.filter((command) => command.source === "extension")
			.map((command) => ({
				name: command.name,
				invocationName: command.invocationName ?? command.name,
				description: command.description,
				sourceInfo: command.sourceInfo,
				handler: async () => {
					throw new Error("Hosted extension commands execute in the session engine, not in the TUI.");
				},
			}));
	}

	getRegisteredCommands(): ResolvedCommand[] {
		return this.commands;
	}

	getCommand(name: string): ResolvedCommand | undefined {
		return (
			this.commands.find((command) => command.invocationName === name) ??
			this.commands.find((command) => command.name === name)
		);
	}

	getCommandDiagnostics(): ReturnType<InteractiveExtensionSurface["getCommandDiagnostics"]> {
		// The engine reports load diagnostics on its own surface.
		return [];
	}

	getShortcutDiagnostics(): ReturnType<InteractiveExtensionSurface["getShortcutDiagnostics"]> {
		return [];
	}

	getShortcuts(
		...args: Parameters<InteractiveExtensionSurface["getShortcuts"]>
	): ReturnType<InteractiveExtensionSurface["getShortcuts"]> {
		void args;
		// Extension shortcut handlers are extension code; they run where the
		// extension was added (supported-surface policy).
		return new Map();
	}

	getEntryRenderer(customType: string): ReturnType<InteractiveExtensionSurface["getEntryRenderer"]> {
		void customType;
		return undefined;
	}

	getMessageRenderer(customType: string): ReturnType<InteractiveExtensionSurface["getMessageRenderer"]> {
		void customType;
		return undefined;
	}

	getModelRegistry(): ModelRegistry {
		return this.registry;
	}

	async emitUserBash(): Promise<undefined> {
		// No reverse event channel: user-bash interception stays embedded-only,
		// matching RPC surfaces today. The execution itself crosses the wire.
		return undefined;
	}
}

/* ------------------------------------------------------------------ */
/*  Session facade                                                     */
/* ------------------------------------------------------------------ */

export interface HostedSessionOptions {
	client: HostedDaemonClient;
	services: AgentSessionServices;
	mirror: HostedStateMirror;
}

export class HostedAgentSession implements InteractiveSessionSurface {
	readonly sessionManager: HostedSessionManager;
	readonly extensionRunner: HostedExtensionSurface;
	readonly agent: InteractiveAgentSurface;

	private readonly client: HostedDaemonClient;
	private readonly services: AgentSessionServices;
	private readonly mirror: HostedStateMirror;
	private readonly listeners = new Set<AgentSessionEventListener>();
	private readonly builtinTools: Record<string, ToolDefinition>;
	private readonly stateView: AgentState;
	private uiContext: ExtensionUIContext | undefined;
	/** Dialog abort controllers by request id; `true` marks external resolution. */
	private readonly dialogs = new Map<string, { controller: AbortController; externallyResolved: boolean }>();
	private turnAbortController = new AbortController();
	private transportValue: Agent["transport"] = "auto";
	private identityListeners = new Set<() => void>();
	/** Set while a runtime-host replacement op owns the rebind flow. */
	replacementInFlight = false;
	private attachedWaiters: Array<() => void> = [];
	private connectionLost: string | null = null;
	private bashCounter = 0;
	private readonly bashChunkListeners = new Map<string, (chunk: string) => void>();

	constructor(options: HostedSessionOptions) {
		this.client = options.client;
		this.services = options.services;
		this.mirror = options.mirror;
		this.sessionManager = new HostedSessionManager(this.mirror, this.client);
		this.extensionRunner = new HostedExtensionSurface(this.services);
		this.builtinTools = createAllToolDefinitions(this.mirror.cwd) as unknown as Record<string, ToolDefinition>;

		const mirror = this.mirror;
		const session = this;
		this.stateView = {
			get systemPrompt() {
				return mirror.systemPrompt;
			},
			get model() {
				return mirror.model as Model<any>;
			},
			get thinkingLevel() {
				return mirror.thinkingLevel;
			},
			get tools() {
				return [];
			},
			set tools(_tools) {
				// Tools live in the engine.
			},
			get messages() {
				return mirror.messages;
			},
			set messages(messages) {
				mirror.messages = messages;
			},
			get isStreaming() {
				return mirror.isStreaming;
			},
			get streamingMessage() {
				return mirror.streamingMessage;
			},
			get pendingToolCalls() {
				return new Set<string>();
			},
			get errorMessage() {
				return undefined;
			},
		} as AgentState;

		this.agent = {
			abort: () => {
				session.turnAbortController.abort();
				session.client.sendCommand({ type: "abort" });
			},
			get signal() {
				return session.turnAbortController.signal;
			},
			get transport() {
				return session.transportValue;
			},
			set transport(transport) {
				session.transportValue = transport;
				session.client.sendCommand({ type: "set_transport", transport });
			},
		} as InteractiveAgentSurface;

		this.client.onFrame((frame) => this.handleFrame(frame));
	}

	/* ---------------- lifecycle / wiring ---------------- */

	/** Seed the mirror; called once after attach and again after identity changes. */
	async seed(): Promise<void> {
		const stateResponse = await this.client.request<{ data: RpcSessionState }>({ type: "get_state" });
		this.mirror.applyState(stateResponse.data);
		const messagesResponse = await this.client.request<{ data: { messages: AgentMessage[] } }>({
			type: "get_messages",
		});
		this.mirror.messages = messagesResponse.data.messages;
		void this.client
			.request<{ data: { systemPrompt: string } }>({ type: "get_system_prompt" })
			.then((response) => {
				this.mirror.systemPrompt = response.data.systemPrompt;
			})
			.catch(() => {});
	}

	/** Runs after another surface replaces the child's session in place. */
	onIdentityChanged(listener: () => void): () => void {
		this.identityListeners.add(listener);
		return () => this.identityListeners.delete(listener);
	}

	/**
	 * Resolves on the next `attached` broadcast — the daemon's confirmation
	 * that it re-learned the child's identity after a replacement command.
	 */
	waitForNextAttached(timeoutMs = 15_000): Promise<void> {
		return new Promise((resolve) => {
			const timer = setTimeout(resolve, timeoutMs);
			timer.unref?.();
			this.attachedWaiters.push(() => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	get connectionLostReason(): string | null {
		return this.connectionLost;
	}

	private handleFrame(frame: Frame): void {
		const type = String(frame.type ?? "");
		if (type === "extension_ui_request") {
			void this.handleUiRequest(frame);
			return;
		}
		if (type === "extension_ui_resolved") {
			const dialog = this.dialogs.get(String(frame.id));
			if (dialog) {
				dialog.externallyResolved = true;
				dialog.controller.abort();
			}
			return;
		}
		if (type === "attached") {
			// The daemon re-broadcasts identity after new_session/fork/resume.
			const newId = String(frame.sessionId ?? "");
			if (newId) this.client.sessionId = newId;
			const waiters = this.attachedWaiters;
			this.attachedWaiters = [];
			if (this.replacementInFlight) {
				// The initiating runtime-host op owns seeding and rebinding.
				for (const waiter of waiters) waiter();
				return;
			}
			if (newId && this.mirror.sessionId && newId !== this.mirror.sessionId) {
				// Another surface replaced the session; follow it.
				void this.seed().then(() => {
					for (const waiter of waiters) waiter();
					for (const listener of [...this.identityListeners]) listener();
				});
				return;
			}
			for (const waiter of waiters) waiter();
			return;
		}
		if (type === "session_exit") {
			this.connectionLost = frame.lastErrorNotify
				? `The session engine exited: ${frame.lastErrorNotify}`
				: "The session engine exited.";
			this.uiContext?.notify(this.connectionLost, "error");
			this.mirror.isStreaming = false;
			this.turnAbortController.abort();
			return;
		}
		if (type === "__connection_lost") {
			this.connectionLost = `Lost the session daemon connection: ${frame.error}`;
			this.uiContext?.notify(this.connectionLost, "error");
			this.mirror.isStreaming = false;
			this.turnAbortController.abort();
			return;
		}
		if (type === "session_stderr") {
			return;
		}
		if (NON_EVENT_FRAMES.has(type)) return;

		// Everything else is the engine's event stream, verbatim.
		const { sessionId: _ignored, ...event } = frame;
		if (event.type === "bash_execution_update" && typeof event.id === "string") {
			this.bashChunkListeners.get(event.id)?.(String(event.delta ?? ""));
		}
		if (event.type === "agent_start") {
			// A fresh turn gets a fresh signal, like a fresh Agent run.
			if (this.turnAbortController.signal.aborted) this.turnAbortController = new AbortController();
		}
		this.mirror.applyEvent(event as AgentSessionEvent);
		if (event.type === "agent_settled") {
			// Reconcile drift (context usage, queue counts) after every turn.
			void this.client
				.request<{ data: RpcSessionState }>({ type: "get_state" })
				.then((response) => this.mirror.applyState(response.data))
				.catch(() => {});
		}
		for (const listener of [...this.listeners]) listener(event as AgentSessionEvent);
	}

	/* ---------------- extension UI bridge ---------------- */

	private async handleUiRequest(frame: Frame): Promise<void> {
		const ui = this.uiContext;
		const method = String(frame.method ?? "");
		const id = typeof frame.id === "string" ? frame.id : undefined;
		if (!ui) return;

		const respond = (payload: Record<string, unknown>) => {
			if (!id) return;
			this.client.send({ type: "extension_ui_response", id, sessionId: this.client.sessionId ?? undefined, ...payload });
		};

		const withDialog = async <T>(run: (signal: AbortSignal) => Promise<T>): Promise<{ value: T; externallyResolved: boolean } | undefined> => {
			if (!id) return undefined;
			const controller = new AbortController();
			const dialog = { controller, externallyResolved: false };
			this.dialogs.set(id, dialog);
			try {
				const value = await run(controller.signal);
				return { value, externallyResolved: dialog.externallyResolved };
			} finally {
				this.dialogs.delete(id);
			}
		};

		switch (method) {
			case "mypiAskUser": {
				const question = String(frame.question ?? "");
				const options = Array.isArray(frame.options)
					? (frame.options as Array<{ label: string; description: string }>)
					: [];
				const recommendedOption = Number(frame.recommendedOption ?? 1);
				// Reconstruct the exact choices the engine-side ask_user tool
				// passed to its own select, so answers round-trip verbatim.
				const choices = options.map((option, index) => {
					const recommendation = recommendedOption === index + 1 ? " (Recommended)" : "";
					return `${index + 1}. ${option.label}${recommendation} — ${option.description}`;
				});
				const otherChoice = "4. Other — Type any response";
				const result = await withDialog((signal) =>
					ui.select(question, [...choices, otherChoice], {
						signal,
						timeout: typeof frame.timeout === "number" ? frame.timeout : undefined,
						mypiAskUser: {
							toolCallId: id,
							question,
							options,
							recommendedOption,
						},
					}),
				);
				if (!result || result.externallyResolved) return;
				if (result.value === undefined) respond({ cancelled: true });
				else respond({ value: result.value });
				return;
			}
			case "select": {
				const result = await withDialog((signal) =>
					ui.select(String(frame.title ?? ""), (frame.options as string[]) ?? [], {
						signal,
						timeout: typeof frame.timeout === "number" ? frame.timeout : undefined,
					}),
				);
				if (!result || result.externallyResolved) return;
				if (result.value === undefined) respond({ cancelled: true });
				else respond({ value: result.value });
				return;
			}
			case "confirm": {
				const result = await withDialog((signal) =>
					ui.confirm(String(frame.title ?? ""), String(frame.message ?? ""), {
						signal,
						timeout: typeof frame.timeout === "number" ? frame.timeout : undefined,
					}),
				);
				if (!result || result.externallyResolved) return;
				respond({ confirmed: result.value });
				return;
			}
			case "input": {
				const result = await withDialog((signal) =>
					ui.input(String(frame.title ?? ""), frame.placeholder === undefined ? undefined : String(frame.placeholder), {
						signal,
						timeout: typeof frame.timeout === "number" ? frame.timeout : undefined,
					}),
				);
				if (!result || result.externallyResolved) return;
				if (result.value === undefined) respond({ cancelled: true });
				else respond({ value: result.value });
				return;
			}
			case "editor": {
				const result = await withDialog((signal) => {
					void signal;
					return ui.editor(String(frame.title ?? ""), frame.prefill === undefined ? undefined : String(frame.prefill));
				});
				if (!result || result.externallyResolved) return;
				if (result.value === undefined) respond({ cancelled: true });
				else respond({ value: result.value });
				return;
			}
			case "dismiss": {
				const dialog = this.dialogs.get(String(frame.targetId));
				if (dialog) {
					dialog.externallyResolved = true;
					dialog.controller.abort();
				}
				return;
			}
			case "notify":
				ui.notify(String(frame.message ?? ""), frame.notifyType as "info" | "warning" | "error" | undefined);
				return;
			case "setStatus":
				ui.setStatus(String(frame.statusKey ?? ""), frame.statusText === undefined ? undefined : String(frame.statusText));
				return;
			case "setWidget":
				ui.setWidget(
					String(frame.widgetKey ?? ""),
					frame.widgetLines as string[] | undefined,
					frame.widgetPlacement ? { placement: frame.widgetPlacement as "aboveEditor" | "belowEditor" } : undefined,
				);
				return;
			case "setTitle":
				ui.setTitle(String(frame.title ?? ""));
				return;
			case "set_editor_text":
				ui.setEditorText(String(frame.text ?? ""));
				return;
			default:
				return;
		}
	}

	/* ---------------- InteractiveSessionSurface ---------------- */

	get modelRuntime() {
		return this.services.modelRuntime;
	}
	get settingsManager() {
		return this.services.settingsManager;
	}
	get resourceLoader() {
		return this.services.resourceLoader;
	}
	get state(): AgentState {
		return this.stateView;
	}
	get model(): Model<any> | undefined {
		return this.mirror.model;
	}
	get thinkingLevel(): ThinkingLevel {
		return this.mirror.thinkingLevel;
	}
	get isStreaming(): boolean {
		return this.mirror.isStreaming;
	}
	get isIdle(): boolean {
		return this.mirror.isIdle;
	}
	get isCompacting(): boolean {
		return this.mirror.isCompacting;
	}
	get isBashRunning(): boolean {
		return this.mirror.isBashRunning;
	}
	get retryAttempt(): number {
		return this.mirror.retryAttempt;
	}
	get systemPrompt(): string {
		return this.mirror.systemPrompt;
	}
	get messages(): AgentMessage[] {
		return this.mirror.messages;
	}
	get steeringMode(): "all" | "one-at-a-time" {
		return this.mirror.steeringMode;
	}
	get followUpMode(): "all" | "one-at-a-time" {
		return this.mirror.followUpMode;
	}
	get autoCompactionEnabled(): boolean {
		return this.mirror.autoCompactionEnabled;
	}
	get pendingMessageCount(): number {
		return this.mirror.steeringQueue.length + this.mirror.followUpQueue.length;
	}
	get scopedModels(): ReadonlyArray<{ model: Model<any>; thinkingLevel?: ThinkingLevel }> {
		return this.mirror.scopedModels;
	}
	get promptTemplates() {
		return this.services.resourceLoader.getPrompts().prompts;
	}

	subscribe(listener: AgentSessionEventListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async bindExtensions(bindings: ExtensionBindings): Promise<void> {
		this.uiContext = bindings.uiContext;
		if (bindings.uiContext && bindings.mode === "tui") {
			// Presentation the TUI owns (hero header, resource viewers) binds
			// locally; the engine's copy of this extension is headless.
			bindHostedTuiChrome(bindings.uiContext, {
				cwd: this.mirror.cwd,
				modelLabel: this.mirror.model ? `${this.mirror.model.provider}/${this.mirror.model.id}` : "No model selected",
				thinkingLevel: this.mirror.thinkingLevel,
			});
		}
		await this.refreshCommands();
	}

	async refreshCommands(): Promise<void> {
		try {
			const response = await this.client.request<{ data: { commands: RpcSlashCommand[] } }>({ type: "get_commands" });
			this.extensionRunner.adoptCommands(response.data.commands);
		} catch {
			// Command autocomplete degrades; commands still work as prompt text.
		}
	}

	/* ------- prompting ------- */

	async prompt(text: string, options?: PromptOptions): Promise<void> {
		// TUI-owned viewer commands never cross the wire.
		if (this.uiContext && (await runHostedResourceCommand(this.uiContext, text))) return;
		await this.client.request({
			type: "prompt",
			message: text,
			images: options?.images,
			streamingBehavior: options?.streamingBehavior,
		});
	}

	async steer(text: string, images?: ImageContent[]): Promise<void> {
		await this.client.request({ type: "steer", message: text, images });
	}

	async followUp(text: string, images?: ImageContent[]): Promise<void> {
		await this.client.request({ type: "follow_up", message: text, images });
	}

	async waitForIdle(): Promise<void> {
		await this.mirror.waitForIdle();
	}

	clearQueue(): { steering: string[]; followUp: string[] } {
		const cleared = { steering: [...this.mirror.steeringQueue], followUp: [...this.mirror.followUpQueue] };
		this.mirror.steeringQueue = [];
		this.mirror.followUpQueue = [];
		this.client.sendCommand({ type: "clear_queue" });
		return cleared;
	}

	getSteeringMessages(): readonly string[] {
		return this.mirror.steeringQueue;
	}

	getFollowUpMessages(): readonly string[] {
		return this.mirror.followUpQueue;
	}

	/* ------- model / thinking ------- */

	async setModel(model: Model<any>): Promise<void> {
		await this.client.request({ type: "set_model", provider: model.provider, modelId: model.id });
		this.mirror.model = model;
	}

	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined> {
		void direction;
		const response = await this.client.request<{ data: ModelCycleResult | null }>({ type: "cycle_model" });
		if (!response.data) return undefined;
		this.mirror.model = response.data.model;
		this.mirror.thinkingLevel = response.data.thinkingLevel;
		return response.data;
	}

	setThinkingLevel(level: ThinkingLevel): void {
		this.mirror.thinkingLevel = level;
		this.client.sendCommand({ type: "set_thinking_level", level });
	}

	cycleThinkingLevel(): ThinkingLevel | undefined {
		const levels = this.getAvailableThinkingLevels();
		if (levels.length <= 1) return undefined;
		const currentIndex = levels.indexOf(this.mirror.thinkingLevel);
		const next = levels[(currentIndex + 1) % levels.length];
		this.setThinkingLevel(next);
		return next;
	}

	getAvailableThinkingLevels(): ThinkingLevel[] {
		if (!this.mirror.model) return THINKING_LEVELS;
		return getSupportedThinkingLevels(this.mirror.model) as ThinkingLevel[];
	}

	setScopedModels(scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>): void {
		this.mirror.scopedModels = scopedModels;
		this.client.sendCommand({
			type: "set_scoped_models",
			models: scopedModels.map((scoped) => ({
				provider: scoped.model.provider,
				modelId: scoped.model.id,
				thinkingLevel: scoped.thinkingLevel,
			})),
		});
	}

	/* ------- modes / toggles ------- */

	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.mirror.steeringMode = mode;
		this.client.sendCommand({ type: "set_steering_mode", mode });
	}

	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.mirror.followUpMode = mode;
		this.client.sendCommand({ type: "set_follow_up_mode", mode });
	}

	setAutoCompactionEnabled(enabled: boolean): void {
		this.mirror.autoCompactionEnabled = enabled;
		this.client.sendCommand({ type: "set_auto_compaction", enabled });
	}

	setSessionName(name: string): void {
		this.mirror.sessionName = name;
		this.client.sendCommand({ type: "set_session_name", name });
	}

	/* ------- compaction / retry ------- */

	async compact(customInstructions?: string): Promise<CompactionResult> {
		const response = await this.client.request<{ data: CompactionResult }>({ type: "compact", customInstructions });
		return response.data;
	}

	abortCompaction(): void {
		this.client.sendCommand({ type: "abort_compaction" });
	}

	abortBranchSummary(): void {
		this.client.sendCommand({ type: "abort_branch_summary" });
	}

	abortRetry(): void {
		this.client.sendCommand({ type: "abort_retry" });
	}

	/* ------- bash ------- */

	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; operations?: unknown; id?: string },
	): Promise<BashResult> {
		this.bashCounter += 1;
		const id = `__tui_bash_${this.bashCounter}`;
		if (onChunk) this.bashChunkListeners.set(id, onChunk);
		this.mirror.isBashRunning = true;
		try {
			const response = await this.client.request<{ data: BashResult }>(
				{ type: "bash", command, excludeFromContext: options?.excludeFromContext, id },
				{ timeoutMs: 24 * 60 * 60_000 },
			);
			return response.data;
		} finally {
			this.mirror.isBashRunning = false;
			if (onChunk) this.bashChunkListeners.delete(id);
		}
	}

	abortBash(): void {
		this.client.sendCommand({ type: "abort_bash" });
	}

	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		this.client.sendCommand({
			type: "record_bash_result",
			command,
			result,
			excludeFromContext: options?.excludeFromContext,
		});
	}

	/* ------- session operations ------- */

	async navigateTree(
		...args: Parameters<InteractiveSessionSurface["navigateTree"]>
	): ReturnType<InteractiveSessionSurface["navigateTree"]> {
		const [targetId, options] = args;
		const response = await this.client.request<{
			data: { text?: string; cancelled: boolean; aborted?: boolean; summaryCreated: boolean };
		}>({
			type: "navigate_tree",
			targetId,
			summarize: options?.summarize,
			customInstructions: options?.customInstructions,
			replaceInstructions: options?.replaceInstructions,
			label: options?.label,
		});
		await this.seed();
		return {
			editorText: response.data.text,
			cancelled: response.data.cancelled,
			aborted: response.data.aborted,
			summaryEntry: undefined,
		} as Awaited<ReturnType<InteractiveSessionSurface["navigateTree"]>>;
	}

	async reload(options?: { beforeSessionStart?: () => void | Promise<void> }): Promise<void> {
		await options?.beforeSessionStart?.();
		await this.services.resourceLoader.reload();
		await this.client.request({ type: "reload" });
		await this.seed();
		await this.refreshCommands();
	}

	/* ------- derived, computed locally ------- */

	getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
		const result: Array<{ entryId: string; text: string }> = [];
		for (const entry of this.sessionManager.getEntries()) {
			if (entry.type !== "message" || entry.message.role !== "user") continue;
			const text = contentText(entry.message.content as Parameters<typeof contentText>[0], "");
			if (text) result.push({ entryId: entry.id, text });
		}
		return result;
	}

	getSessionStats(): SessionStats {
		let userMessages = 0;
		let assistantMessages = 0;
		let toolResults = 0;
		let totalMessages = 0;
		let toolCalls = 0;
		const usageTotals = createUsageTotals();

		for (const entry of this.sessionManager.getEntries()) {
			if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
				addUsageToTotals(usageTotals, entry.usage);
			}
			if (entry.type !== "message") continue;
			totalMessages++;
			const message = entry.message;
			if (message.role === "user") {
				userMessages++;
			} else if (message.role === "toolResult") {
				toolResults++;
				if (message.usage) addUsageToTotals(usageTotals, message.usage);
			} else if (message.role === "assistant") {
				assistantMessages++;
				const assistantMsg = message as AssistantMessage;
				if (Array.isArray(assistantMsg.content)) {
					toolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;
				}
				addUsageToTotals(usageTotals, assistantMsg.usage);
			}
		}

		return {
			sessionFile: this.mirror.sessionFile,
			sessionId: this.mirror.sessionId,
			userMessages,
			assistantMessages,
			toolCalls,
			toolResults,
			totalMessages,
			tokens: {
				input: usageTotals.input,
				output: usageTotals.output,
				cacheRead: usageTotals.cacheRead,
				cacheWrite: usageTotals.cacheWrite,
				total: usageTotals.input + usageTotals.output + usageTotals.cacheRead + usageTotals.cacheWrite,
			},
			cost: usageTotals.cost,
			contextUsage: this.getContextUsage(),
		};
	}

	getContextUsage(): ContextUsage | undefined {
		const model = this.mirror.model;
		if (!model) return undefined;
		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;

		const branchEntries = this.sessionManager.getBranch();
		const latestCompaction = getLatestCompactionEntry(branchEntries);
		if (latestCompaction) {
			const compactionIndex = branchEntries.lastIndexOf(latestCompaction);
			let hasPostCompactionUsage = false;
			for (let i = branchEntries.length - 1; i > compactionIndex; i--) {
				const entry = branchEntries[i];
				if (entry.type === "message" && entry.message.role === "assistant") {
					const assistant = entry.message as AssistantMessage;
					if (assistant.stopReason !== "aborted" && assistant.stopReason !== "error" && assistant.usage) {
						if (calculateContextTokens(assistant.usage) > 0) {
							hasPostCompactionUsage = true;
							break;
						}
					}
				}
			}
			if (!hasPostCompactionUsage) {
				return { tokens: null, contextWindow, percent: null };
			}
		}

		const estimate = estimateContextTokens(this.mirror.messages);
		return {
			tokens: estimate.tokens,
			contextWindow,
			percent: (estimate.tokens / contextWindow) * 100,
		};
	}

	getLastAssistantText(): string | undefined {
		for (let i = this.mirror.messages.length - 1; i >= 0; i--) {
			const message = this.mirror.messages[i];
			if (message.role === "assistant") {
				const text = contentText((message as AssistantMessage).content, "");
				return text || undefined;
			}
		}
		return undefined;
	}

	getToolDefinition(name: string): ToolDefinition | undefined {
		// Built-in tools are local code, so their rich rendering survives the
		// wire; extension tools fall back to the standard tool card.
		return this.builtinTools[name];
	}

	/* ------- identity / export ------- */

	get sessionId(): string {
		return this.mirror.sessionId;
	}
	get sessionFile(): string | undefined {
		return this.mirror.sessionFile;
	}
	get sessionName(): string | undefined {
		return this.mirror.sessionName;
	}

	async exportToHtml(outputPath?: string): Promise<string> {
		const response = await this.client.request<{ data: { path: string } }>({ type: "export_html", outputPath });
		return response.data.path;
	}

	exportToJsonl(outputPath?: string): string {
		// Reads only the session file; fully local.
		const filePath = resolvePath(
			outputPath ?? `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
			process.cwd(),
		);
		const dir = dirname(filePath);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.mirror.sessionId,
			timestamp: new Date().toISOString(),
			cwd: this.mirror.cwd,
		};
		const branchEntries = this.sessionManager.getBranch();
		const lines = [JSON.stringify(header)];
		let prevId: string | null = null;
		for (const entry of branchEntries) {
			lines.push(JSON.stringify({ ...entry, parentId: prevId }));
			prevId = entry.id;
		}
		writeFileSync(filePath, `${lines.join("\n")}\n`);
		return filePath;
	}
}
