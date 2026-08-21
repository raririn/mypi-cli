/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 *
 * Protocol:
 * - Commands: JSON objects with `type` field, optional `id` for correlation
 * - Responses: JSON objects with `type: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: AgentSessionEvent objects streamed as they occur
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 */

import * as crypto from "node:crypto";
import { existsSync } from "node:fs";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "../../core/extensions/index.ts";
import {
	flushRawStdout,
	takeOverStdout,
	waitForRawStdoutBackpressure,
	writeRawStdout,
} from "../../core/output-guard.ts";
import { SessionManager } from "../../core/session-manager.ts";
import { hasProductAuthority } from "../../core/source-info.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import { type Theme, theme } from "../interactive/theme/theme.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
	RpcSlashCommand,
} from "./rpc-types.ts";

interface AskUserOption {
	label: string;
	description: string;
}

interface AskUserMetadata {
	toolCallId: string;
	question: string;
	options: [AskUserOption, AskUserOption, AskUserOption];
	recommendedOption: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTrustedMyPiAskUser(session: AgentSessionRuntime["session"]): boolean {
	const tool = session.getAllTools().find((candidate) => candidate.name === "ask_user");
	return hasProductAuthority(tool?.sourceInfo, ["capability"]);
}

function parseAskUserMetadata(value: unknown): AskUserMetadata | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.toolCallId !== "string" || value.toolCallId.length === 0 || value.toolCallId.length > 512) {
		return undefined;
	}
	if (typeof value.question !== "string" || value.question.length === 0 || value.question.length > 2000) {
		return undefined;
	}
	if (
		!Number.isInteger(value.recommendedOption) ||
		(value.recommendedOption as number) < 1 ||
		(value.recommendedOption as number) > 3
	) {
		return undefined;
	}
	if (!Array.isArray(value.options) || value.options.length !== 3) return undefined;
	const options: AskUserOption[] = [];
	for (const option of value.options) {
		if (!isRecord(option)) return undefined;
		if (typeof option.label !== "string" || option.label.length === 0 || option.label.length > 120) {
			return undefined;
		}
		if (
			typeof option.description !== "string" ||
			option.description.length === 0 ||
			option.description.length > 300
		) {
			return undefined;
		}
		options.push({ label: option.label, description: option.description });
	}
	return {
		toolCallId: value.toolCallId,
		question: value.question,
		options: options as AskUserMetadata["options"],
		recommendedOption: value.recommendedOption as number,
	};
}

function sameAskUserMetadata(left: AskUserMetadata, right: AskUserMetadata): boolean {
	return (
		left.toolCallId === right.toolCallId &&
		left.question === right.question &&
		left.recommendedOption === right.recommendedOption &&
		left.options.every(
			(option, index) =>
				option.label === right.options[index]?.label && option.description === right.options[index]?.description,
		)
	);
}

// Re-export types for consumers
export type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
} from "./rpc-types.ts";

/**
 * Run in RPC mode.
 * Listens for JSON commands on stdin, outputs events and responses on stdout.
 */
export async function runRpcMode(runtimeHost: AgentSessionRuntime): Promise<never> {
	takeOverStdout();
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;
	let unsubscribeBackpressure: (() => void) | undefined;

	const output = (obj: RpcResponse | RpcExtensionUIRequest | object) => {
		writeRawStdout(serializeJsonLine(obj));
	};

	const success = <T extends RpcCommand["type"]>(
		id: string | undefined,
		command: T,
		data?: object | null,
	): RpcResponse => {
		if (data === undefined) {
			return { id, type: "response", command, success: true } as RpcResponse;
		}
		return { id, type: "response", command, success: true, data } as RpcResponse;
	};

	const error = (id: string | undefined, command: string, message: string): RpcResponse => {
		return { id, type: "response", command, success: false, error: message };
	};

	// Pending extension UI requests waiting for response
	const pendingExtensionRequests = new Map<
		string,
		{ resolve: (value: RpcExtensionUIResponse) => void; reject: (error: Error) => void }
	>();
	let agentRunsStarted = 0;
	const activeTrustedAskUserCalls = new Map<string, AskUserMetadata>();

	// Shutdown request flag
	let shutdownRequested = false;
	let shuttingDown = false;
	const signalCleanupHandlers: Array<() => void> = [];

	/** Helper for dialog methods with signal/timeout support */
	function createDialogPromise<T>(
		opts: ExtensionUIDialogOptions | undefined,
		defaultValue: T,
		request: Record<string, unknown>,
		parseResponse: (response: RpcExtensionUIResponse) => T,
	): Promise<T> {
		if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

		const id = crypto.randomUUID();
		return new Promise((resolve, reject) => {
			let timeoutId: ReturnType<typeof setTimeout> | undefined;

			const cleanup = () => {
				if (timeoutId) clearTimeout(timeoutId);
				opts?.signal?.removeEventListener("abort", onAbort);
				if (pendingExtensionRequests.delete(id)) {
					output({
						type: "extension_ui_request",
						id: crypto.randomUUID(),
						method: "dismiss",
						targetId: id,
					});
				}
			};

			const onAbort = () => {
				cleanup();
				resolve(defaultValue);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			if (opts?.timeout) {
				timeoutId = setTimeout(() => {
					cleanup();
					resolve(defaultValue);
				}, opts.timeout);
			}

			pendingExtensionRequests.set(id, {
				resolve: (response: RpcExtensionUIResponse) => {
					cleanup();
					resolve(parseResponse(response));
				},
				reject,
			});
			output({ type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest);
		});
	}

	/**
	 * Create an extension UI context that uses the RPC protocol.
	 */
	const createExtensionUIContext = (): ExtensionUIContext => ({
		select: (title, options, opts) => {
			const metadata = parseAskUserMetadata(opts?.mypiAskUser);
			const active = metadata ? activeTrustedAskUserCalls.get(metadata.toolCallId) : undefined;
			const request =
				metadata && active && sameAskUserMetadata(metadata, active) && title === metadata.question
					? {
							method: "mypiAskUser",
							question: metadata.question,
							options: metadata.options,
							recommendedOption: metadata.recommendedOption,
							timeout: opts?.timeout,
						}
					: { method: "select", title, options, timeout: opts?.timeout };
			return createDialogPromise(opts, undefined, request, (r) =>
				"cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
			);
		},

		confirm: (title, message, opts) =>
			createDialogPromise(opts, false, { method: "confirm", title, message, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? false : "confirmed" in r ? r.confirmed : false,
			),

		input: (title, placeholder, opts) =>
			createDialogPromise(opts, undefined, { method: "input", title, placeholder, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
			),

		notify(message: string, type?: "info" | "warning" | "error"): void {
			// Fire and forget - no response needed
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "notify",
				message,
				notifyType: type,
			} as RpcExtensionUIRequest);
		},

		onTerminalInput(): () => void {
			// Raw terminal input not supported in RPC mode
			return () => {};
		},

		setStatus(key: string, text: string | undefined): void {
			// Fire and forget - no response needed
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setStatus",
				statusKey: key,
				statusText: text,
			} as RpcExtensionUIRequest);
		},

		setWorkingMessage(_message?: string): void {
			// Working message not supported in RPC mode - requires TUI loader access
		},

		setWorkingVisible(_visible: boolean): void {
			// Working visibility not supported in RPC mode - requires TUI loader access
		},

		setWorkingIndicator(_options?: WorkingIndicatorOptions): void {
			// Working indicator customization not supported in RPC mode - requires TUI loader access
		},

		setHiddenThinkingLabel(_label?: string): void {
			// Hidden thinking label not supported in RPC mode - requires TUI message rendering access
		},

		setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
			// Only support string arrays in RPC mode - factory functions are ignored
			if (content === undefined || Array.isArray(content)) {
				output({
					type: "extension_ui_request",
					id: crypto.randomUUID(),
					method: "setWidget",
					widgetKey: key,
					widgetLines: content as string[] | undefined,
					widgetPlacement: options?.placement,
				} as RpcExtensionUIRequest);
			}
			// Component factories are not supported in RPC mode - would need TUI access
		},

		setFooter(_factory: unknown): void {
			// Custom footer not supported in RPC mode - requires TUI access
		},

		setHeader(_factory: unknown): void {
			// Custom header not supported in RPC mode - requires TUI access
		},

		setTitle(title: string): void {
			// Fire and forget - host can implement terminal title control
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setTitle",
				title,
			} as RpcExtensionUIRequest);
		},

		async custom() {
			// Custom UI not supported in RPC mode
			return undefined as never;
		},

		pasteToEditor(text: string): void {
			// Paste handling not supported in RPC mode - falls back to setEditorText
			this.setEditorText(text);
		},

		setEditorText(text: string): void {
			// Fire and forget - host can implement editor control
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "set_editor_text",
				text,
			} as RpcExtensionUIRequest);
		},

		getEditorText(): string {
			// Synchronous method can't wait for RPC response
			// Host should track editor state locally if needed
			return "";
		},

		async editor(title: string, prefill?: string): Promise<string | undefined> {
			const id = crypto.randomUUID();
			return new Promise((resolve, reject) => {
				pendingExtensionRequests.set(id, {
					resolve: (response: RpcExtensionUIResponse) => {
						if ("cancelled" in response && response.cancelled) {
							resolve(undefined);
						} else if ("value" in response) {
							resolve(response.value);
						} else {
							resolve(undefined);
						}
					},
					reject,
				});
				output({ type: "extension_ui_request", id, method: "editor", title, prefill } as RpcExtensionUIRequest);
			});
		},

		addAutocompleteProvider(): void {
			// Autocomplete provider composition is not supported in RPC mode
		},

		setEditorComponent(): void {
			// Custom editor components not supported in RPC mode
		},

		getEditorComponent() {
			// Custom editor components not supported in RPC mode
			return undefined;
		},

		get theme() {
			return theme;
		},

		getAllThemes() {
			return [];
		},

		getTheme(_name: string) {
			return undefined;
		},

		setTheme(_theme: string | Theme) {
			// Theme switching not supported in RPC mode
			return { success: false, error: "Theme switching not supported in RPC mode" };
		},

		getToolsExpanded() {
			// Tool expansion not supported in RPC mode - no TUI
			return false;
		},

		setToolsExpanded(_expanded: boolean) {
			// Tool expansion not supported in RPC mode - no TUI
		},
	});

	runtimeHost.setRebindSession(async () => {
		await rebindSession();
	});

	const assertExtensionReplacementIsLocal = (operation: string): void => {
		if (process.env.MYPI_DAEMON_ENGINE !== "1") return;
		throw new Error(
			`An engine-side extension cannot run ${operation} inside a daemon-hosted session because that would move every client sharing the child. ` +
				"Use the surface's requester-local session command instead.",
		);
	};

	const rebindSession = async (): Promise<void> => {
		session = runtimeHost.session;
		await session.bindExtensions({
			uiContext: createExtensionUIContext(),
			mode: "rpc",
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: async (options) => {
					assertExtensionReplacementIsLocal("newSession");
					return runtimeHost.newSession(options);
				},
				fork: async (entryId, forkOptions) => {
					assertExtensionReplacementIsLocal("fork");
					const result = await runtimeHost.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, options) => {
					const result = await session.navigateTree(targetId, {
						summarize: options?.summarize,
						customInstructions: options?.customInstructions,
						replaceInstructions: options?.replaceInstructions,
						label: options?.label,
					});
					return { cancelled: result.cancelled, text: result.editorText };
				},
				switchSession: async (sessionPath, options) => {
					assertExtensionReplacementIsLocal("switchSession");
					return runtimeHost.switchSession(sessionPath, options);
				},
				reload: async () => {
					await session.reload();
				},
			},
			shutdownHandler: () => {
				shutdownRequested = true;
			},
			onError: (err) => {
				output({ type: "extension_error", extensionPath: err.extensionPath, event: err.event, error: err.error });
			},
		});

		unsubscribe?.();
		unsubscribeBackpressure?.();
		activeTrustedAskUserCalls.clear();
		unsubscribe = session.subscribe((event) => {
			if (event.type === "agent_start") agentRunsStarted += 1;
			if (event.type === "tool_execution_start" && event.toolName === "ask_user" && isTrustedMyPiAskUser(session)) {
				const args = isRecord(event.args) ? event.args : {};
				const metadata = parseAskUserMetadata({ toolCallId: event.toolCallId, ...args });
				if (metadata) activeTrustedAskUserCalls.set(event.toolCallId, metadata);
			}
			output(event);
			if (event.type === "tool_execution_end") {
				activeTrustedAskUserCalls.delete(event.toolCallId);
			}
			if (event.type === "agent_settled") {
				void checkShutdownRequested();
			}
		});
		unsubscribeBackpressure = session.agent.subscribe(async () => {
			await waitForRawStdoutBackpressure();
		});
	};

	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				killTrackedDetachedChildren();
				void shutdown(signal === "SIGHUP" ? 129 : 143, signal);
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	await rebindSession();
	registerSignalHandlers();

	// Handle a single command
	const getExternallyCurrentModels = async () => {
		// A hosted TUI/GUI may complete login and catalog discovery in its own
		// process. Reload both the credential and the provider-scoped disk cache;
		// reloading auth alone leaves dynamic provider getModels() state empty.
		await session.modelRuntime.reloadPersistedModelState();
		return session.modelRuntime.getAvailable();
	};

	const handleCommand = async (command: RpcCommand): Promise<RpcResponse | undefined> => {
		const id = command.id;

		switch (command.type) {
			// =================================================================
			// Prompting
			// =================================================================

			case "prompt": {
				// Start prompt handling immediately, but emit the authoritative response only after
				// prompt preflight succeeds. Queued and immediately handled prompts also count as success.
				let preflightSucceeded = false;
				const runsBefore = agentRunsStarted;
				void session
					.prompt(command.message, {
						images: command.images,
						streamingBehavior: command.streamingBehavior,
						structuredOutput: command.structuredOutput
							? { ...command.structuredOutput, requestId: id }
							: undefined,
						source: "rpc",
						preflightResult: (didSucceed) => {
							if (didSucceed) {
								preflightSucceeded = true;
								output(success(id, "prompt"));
							}
						},
					})
					.then(() => {
						// Extension commands and input-hook-handled prompts can
						// complete without ever starting an agent run; RPC clients
						// gate the turn on agent_settled, which would never come.
						// Emit a synthetic settle so the turn closes.
						if (preflightSucceeded && agentRunsStarted === runsBefore && !session.isStreaming) {
							output({ type: "agent_settled", outcome: { kind: "success" } } as Parameters<typeof output>[0]);
						}
					})
					.catch((e) => {
						if (!preflightSucceeded) {
							output(error(id, "prompt", e.message));
						}
					});
				return undefined;
			}

			case "steer": {
				const queueId = await session.steerWithId(command.message, command.images);
				return success(id, "steer", { queueId });
			}

			case "follow_up": {
				const queueId = await session.followUpWithId(command.message, command.images);
				return success(id, "follow_up", { queueId });
			}

			case "abort": {
				await session.abort();
				return success(id, "abort");
			}

			case "new_session": {
				const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
				const result = await runtimeHost.newSession(options);
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "new_session", result);
			}

			case "prepare_new_session": {
				const result = await runtimeHost.prepareNewSession();
				if (result.cancelled || command.materialize !== true) {
					return success(id, "prepare_new_session", result);
				}
				const sourceManager = session.sessionManager;
				if (!sourceManager.isPersisted()) {
					throw new Error("Daemon-backed /new requires a persisted source session.");
				}
				const targetManager = SessionManager.create(
					sourceManager.getCwd(),
					sourceManager.getSessionDir(),
					command.parentSession ? { parentSession: command.parentSession } : undefined,
				);
				const sessionFile = targetManager.materialize();
				if (!sessionFile) throw new Error("Failed to materialize the new session target.");
				return success(id, "prepare_new_session", {
					cancelled: false,
					target: {
						sessionId: targetManager.getSessionId(),
						sessionFile,
						cwd: targetManager.getCwd(),
					},
				});
			}

			// =================================================================
			// State
			// =================================================================

			case "get_state": {
				const sessionManager = session.sessionManager;
				const state: RpcSessionState = {
					model: session.model,
					thinkingLevel: session.thinkingLevel,
					safetyPolicyEnabled: session.safetyPolicyEnabled,
					safetyMode: session.safetyMode,
					...(session.pendingSafetyMode ? { pendingSafetyMode: session.pendingSafetyMode } : {}),
					isStreaming: session.isStreaming,
					isCompacting: session.isCompacting,
					steeringMode: session.steeringMode,
					followUpMode: session.followUpMode,
					sessionFile: session.sessionFile,
					sessionId: session.sessionId,
					sessionName: session.sessionName,
					autoCompactionEnabled: session.autoCompactionEnabled,
					messageCount: session.messages.length,
					pendingMessageCount: session.pendingMessageCount,
					cwd: sessionManager.getCwd(),
					sessionDir: sessionManager.getSessionDir(),
					usesDefaultSessionDir: sessionManager.usesDefaultSessionDir(),
					isPersisted: sessionManager.isPersisted(),
					leafId: sessionManager.getLeafId(),
					scopedModels: [...session.scopedModels],
					retryAttempt: session.retryAttempt,
					isRetrying: session.isRetrying,
					autoRetryEnabled: session.autoRetryEnabled,
					isBashRunning: session.isBashRunning,
					contextUsage: session.getContextUsage(),
					steeringQueue: [...session.getSteeringMessages()],
					followUpQueue: [...session.getFollowUpMessages()],
					queuedItems: [...session.getQueuedMessageItems()],
					supportsThinking: session.supportsThinking(),
				};
				return success(id, "get_state", state);
			}

			case "request_safety_mode": {
				session.requestSafetyMode(command.mode);
				return success(id, "request_safety_mode");
			}

			case "notify_parent_detached": {
				session.notifyParentDetached();
				return success(id, "notify_parent_detached");
			}

			case "set_global_safety_mode": {
				session.setGlobalSafetyMode(command.mode);
				return success(id, "set_global_safety_mode");
			}

			// =================================================================
			// Model
			// =================================================================

			case "set_model": {
				const models = await getExternallyCurrentModels();
				const model = models.find((m) => m.provider === command.provider && m.id === command.modelId);
				if (!model) {
					return error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
				}
				if (command.global === true) await session.setModel(model, { persistGlobal: true });
				else await session.setModel(model);
				return success(id, "set_model", model);
			}

			case "cycle_model": {
				const result = await session.cycleModel();
				if (!result) {
					return success(id, "cycle_model", null);
				}
				return success(id, "cycle_model", result);
			}

			case "get_available_models": {
				const models = await getExternallyCurrentModels();
				return success(id, "get_available_models", { models });
			}

			// =================================================================
			// Thinking
			// =================================================================

			case "set_thinking_level": {
				session.setThinkingLevel(command.level);
				return success(id, "set_thinking_level");
			}

			case "cycle_thinking_level": {
				const level = session.cycleThinkingLevel();
				if (!level) {
					return success(id, "cycle_thinking_level", null);
				}
				return success(id, "cycle_thinking_level", { level });
			}

			case "get_available_thinking_levels": {
				const levels = session.getAvailableThinkingLevels();
				return success(id, "get_available_thinking_levels", { levels });
			}

			// =================================================================
			// Queue Modes
			// =================================================================

			case "set_steering_mode": {
				session.setSteeringMode(command.mode);
				return success(id, "set_steering_mode");
			}

			case "set_follow_up_mode": {
				session.setFollowUpMode(command.mode);
				return success(id, "set_follow_up_mode");
			}

			// =================================================================
			// Compaction
			// =================================================================

			case "compact": {
				const result = await session.compact(command.customInstructions);
				return success(id, "compact", result);
			}

			case "set_auto_compaction": {
				session.setAutoCompactionEnabled(command.enabled);
				return success(id, "set_auto_compaction");
			}

			// =================================================================
			// Retry
			// =================================================================

			case "set_auto_retry": {
				session.setAutoRetryEnabled(command.enabled);
				return success(id, "set_auto_retry");
			}

			case "abort_retry": {
				session.abortRetry();
				return success(id, "abort_retry");
			}

			// =================================================================
			// Bash
			// =================================================================

			case "bash": {
				const result = await session.executeBash(command.command, undefined, {
					excludeFromContext: command.excludeFromContext,
					id,
				});
				return success(id, "bash", result);
			}

			case "abort_bash": {
				session.abortBash();
				return success(id, "abort_bash");
			}

			// =================================================================
			// Session
			// =================================================================

			case "get_session_stats": {
				const stats = session.getSessionStats();
				return success(id, "get_session_stats", stats);
			}

			case "export_html": {
				const path = await session.exportToHtml(command.outputPath);
				return success(id, "export_html", { path });
			}

			case "switch_session": {
				const result = await runtimeHost.switchSession(
					command.sessionPath,
					command.cwdOverride ? { cwdOverride: command.cwdOverride } : undefined,
				);
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "switch_session", result);
			}

			case "navigate_tree": {
				const result = await session.navigateTree(command.targetId, {
					summarize: command.summarize,
					customInstructions: command.customInstructions,
					replaceInstructions: command.replaceInstructions,
					label: command.label,
				});
				return success(id, "navigate_tree", {
					text: result.editorText,
					cancelled: result.cancelled,
					aborted: result.aborted,
					summaryCreated: Boolean(result.summaryEntry),
				});
			}

			case "fork": {
				const result = await runtimeHost.fork(
					command.entryId,
					command.position ? { position: command.position } : undefined,
				);
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "fork", { text: result.selectedText, cancelled: result.cancelled });
			}

			case "prepare_fork": {
				const result = await runtimeHost.prepareFork(
					command.entryId,
					command.position ? { position: command.position } : undefined,
				);
				if (result.cancelled || command.materialize !== true) {
					return success(id, "prepare_fork", {
						cancelled: result.cancelled,
						targetLeafId: result.targetLeafId,
						text: result.selectedText,
					});
				}
				const sourceManager = session.sessionManager;
				const sourceFile = sourceManager.getSessionFile();
				if (!sourceManager.isPersisted() || !sourceFile) {
					throw new Error("Daemon-backed /fork requires a persisted source session.");
				}
				if (!existsSync(sourceFile)) {
					throw new Error(
						"This session has not been saved yet. Wait for the first assistant response before cloning or forking it.",
					);
				}
				let targetManager: SessionManager;
				if (result.targetLeafId) {
					targetManager = SessionManager.open(sourceFile, sourceManager.getSessionDir());
					if (!targetManager.createBranchedSession(result.targetLeafId)) {
						throw new Error("Failed to create forked session");
					}
				} else {
					targetManager = SessionManager.create(sourceManager.getCwd(), sourceManager.getSessionDir(), {
						parentSession: sourceFile,
					});
				}
				const sessionFile = targetManager.materialize();
				if (!sessionFile) throw new Error("Failed to materialize the fork target.");
				return success(id, "prepare_fork", {
					cancelled: result.cancelled,
					targetLeafId: result.targetLeafId,
					text: result.selectedText,
					target: {
						sessionId: targetManager.getSessionId(),
						sessionFile,
						cwd: targetManager.getCwd(),
					},
				});
			}

			case "clone": {
				const leafId = session.sessionManager.getLeafId();
				if (!leafId) {
					return error(id, "clone", "Cannot clone session: no current entry selected");
				}
				const result = await runtimeHost.fork(leafId, { position: "at" });
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "clone", { cancelled: result.cancelled });
			}

			case "get_fork_messages": {
				const messages = session.getUserMessagesForForking();
				return success(id, "get_fork_messages", { messages });
			}

			case "get_entries": {
				const sessionManager = session.sessionManager;
				let entries = sessionManager.getEntries();
				if (command.since !== undefined) {
					const sinceIndex = entries.findIndex((e) => e.id === command.since);
					if (sinceIndex === -1) {
						return error(id, "get_entries", `Entry not found: ${command.since}`);
					}
					entries = entries.slice(sinceIndex + 1);
				}
				return success(id, "get_entries", { entries, leafId: sessionManager.getLeafId() });
			}

			case "get_tree": {
				const sessionManager = session.sessionManager;
				return success(id, "get_tree", { tree: sessionManager.getTree(), leafId: sessionManager.getLeafId() });
			}

			case "get_last_assistant_text": {
				const text = session.getLastAssistantText();
				return success(id, "get_last_assistant_text", { text });
			}

			case "set_session_name": {
				const name = command.name.trim();
				if (!name) {
					return error(id, "set_session_name", "Session name cannot be empty");
				}
				session.setSessionName(name);
				return success(id, "set_session_name");
			}

			// =================================================================
			// Messages
			// =================================================================

			case "get_messages": {
				return success(id, "get_messages", { messages: session.messages });
			}

			// =================================================================
			// Commands (available for invocation via prompt)
			// =================================================================

			case "get_commands": {
				const commands: RpcSlashCommand[] = [];

				for (const command of session.extensionRunner.getRegisteredCommands()) {
					commands.push({
						name: command.name,
						invocationName: command.invocationName,
						description: command.description,
						source: "extension",
						sourceInfo: command.sourceInfo,
					});
				}

				for (const template of session.promptTemplates) {
					commands.push({
						name: template.name,
						description: template.description,
						source: "prompt",
						sourceInfo: template.sourceInfo,
					});
				}

				for (const skill of session.resourceLoader.getSkills().skills) {
					commands.push({
						name: `skill:${skill.name}`,
						description: skill.description,
						source: "skill",
						sourceInfo: skill.sourceInfo,
					});
				}

				return success(id, "get_commands", { commands });
			}

			case "get_command_completions": {
				// Argument autocomplete for hosted surfaces: the engine owns the
				// registered completion callbacks, so clients round-trip a prefix.
				const registered = session.extensionRunner.getCommand(command.name);
				if (!registered?.getArgumentCompletions) {
					return success(id, "get_command_completions", { completions: null });
				}
				let items: Awaited<ReturnType<NonNullable<typeof registered.getArgumentCompletions>>>;
				try {
					items = await registered.getArgumentCompletions(String(command.prefix ?? ""));
				} catch {
					items = null;
				}
				const completions = items
					? items.slice(0, 200).map((item) => ({
							value: String(item.value),
							label: String(item.label ?? item.value),
							...(typeof item.description === "string" ? { description: item.description } : {}),
						}))
					: null;
				return success(id, "get_command_completions", { completions });
			}

			// =================================================================
			// Hosted-surface support (FEAT-061 Phase B)
			// =================================================================

			case "set_scoped_models": {
				const available = await getExternallyCurrentModels();
				const resolved: Array<{ model: (typeof available)[number]; thinkingLevel?: (typeof command.models)[number]["thinkingLevel"] }> =
					[];
				for (const requested of command.models) {
					const model = available.find((m) => m.provider === requested.provider && m.id === requested.modelId);
					if (!model) {
						return error(id, "set_scoped_models", `Model not found: ${requested.provider}/${requested.modelId}`);
					}
					resolved.push({ model, thinkingLevel: requested.thinkingLevel });
				}
				session.setScopedModels(resolved);
				return success(id, "set_scoped_models");
			}

			case "clear_queue": {
				const cleared = session.clearQueue();
				return success(id, "clear_queue", { steering: cleared.steering, followUp: cleared.followUp });
			}

			case "clear_steering_queue": {
				const steering = session.clearSteeringMessages();
				return success(id, "clear_steering_queue", { steering });
			}

			case "remove_queued": {
				const removed = session.removeQueuedMessage(command.queueId);
				if (!removed) return error(id, "remove_queued", `Queued message not found: ${command.queueId}`);
				return success(id, "remove_queued", removed);
			}

			case "update_queued": {
				const updated = session.updateQueuedMessage(command.queueId, command.message);
				if (!updated) return error(id, "update_queued", `Queued message cannot be updated: ${command.queueId}`);
				return success(id, "update_queued", updated);
			}

			case "abort_compaction": {
				session.abortCompaction();
				return success(id, "abort_compaction");
			}

			case "abort_branch_summary": {
				session.abortBranchSummary();
				return success(id, "abort_branch_summary");
			}

			case "reload": {
				await session.reload();
				return success(id, "reload");
			}

			case "record_bash_result": {
				session.recordBashResult(command.command, command.result, {
					excludeFromContext: command.excludeFromContext,
				});
				return success(id, "record_bash_result");
			}

			case "export_jsonl": {
				const path = session.exportToJsonl(command.outputPath);
				return success(id, "export_jsonl", { path });
			}

			case "append_label_change": {
				const entryId = session.sessionManager.appendLabelChange(command.targetId, command.label);
				return success(id, "append_label_change", { entryId });
			}

			case "get_system_prompt": {
				return success(id, "get_system_prompt", { systemPrompt: session.systemPrompt });
			}

			case "set_transport": {
				session.agent.transport = command.transport as typeof session.agent.transport;
				return success(id, "set_transport");
			}

			default: {
				const unknownCommand = command as { type: string };
				return error(id, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
			}
		}
	};

	/**
	 * Check if shutdown was requested and perform shutdown if so.
	 * Called after handling each command when waiting for the next command.
	 */
	let detachInput = () => {};

	async function shutdown(exitCode = 0, signal?: NodeJS.Signals): Promise<never> {
		if (shuttingDown) {
			process.exit(exitCode);
		}
		shuttingDown = true;
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		unsubscribe?.();
		unsubscribeBackpressure?.();
		await runtimeHost.dispose();
		detachInput();
		process.stdin.pause();
		if (signal !== "SIGTERM") {
			await flushRawStdout();
		}
		process.exit(exitCode);
	}

	async function checkShutdownRequested(): Promise<void> {
		if (!shutdownRequested) return;
		await shutdown();
	}

	const handleInputLine = async (line: string) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (parseError: unknown) {
			output(
				error(
					undefined,
					"parse",
					`Failed to parse command: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
				),
			);
			await waitForRawStdoutBackpressure();
			return;
		}

		// Handle extension UI responses
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"type" in parsed &&
			parsed.type === "extension_ui_response"
		) {
			const response = parsed as RpcExtensionUIResponse;
			const pending = pendingExtensionRequests.get(response.id);
			if (pending) {
				pendingExtensionRequests.delete(response.id);
				pending.resolve(response);
			}
			return;
		}

		const command = parsed as RpcCommand;
		try {
			const response = await handleCommand(command);
			if (response) {
				output(response);
				await waitForRawStdoutBackpressure();
			}
			await checkShutdownRequested();
		} catch (commandError: unknown) {
			output(
				error(
					command.id,
					command.type,
					commandError instanceof Error ? commandError.message : String(commandError),
				),
			);
			await waitForRawStdoutBackpressure();
		}
	};

	const onInputEnd = () => {
		void shutdown();
	};
	process.stdin.on("end", onInputEnd);

	detachInput = (() => {
		const detachJsonl = attachJsonlLineReader(process.stdin, (line) => {
			void handleInputLine(line);
		});
		return () => {
			detachJsonl();
			process.stdin.off("end", onInputEnd);
		};
	})();

	// Keep process alive forever
	return new Promise(() => {});
}
