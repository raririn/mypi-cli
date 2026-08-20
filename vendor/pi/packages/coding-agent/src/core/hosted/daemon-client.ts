/**
 * Socket client for the MyPi session daemon (FEAT-061 Phase B).
 *
 * The hosted TUI is a daemon client like CloudCLI and `mypi attach`: it
 * attaches to (or creates) one session, sends routed RPC commands, and
 * receives the engine's event stream plus extension UI requests. Discovery
 * and daemon spawning stay in the product launcher; this module only dials
 * the socket it is given via the environment:
 *
 *   MYPI_TUI_HOSTED=1          opt into the hosted TUI
 *   MYPI_DAEMON_SOCKET=<path>  the daemon socket to dial
 *   MYPI_DAEMON_PROTOCOL=<n>   exact-match protocol number
 *
 * The protocol is deliberately refused on mismatch rather than negotiated;
 * the launcher and daemon ship together.
 */

import net from "node:net";

export interface HostedDaemonEnv {
	socketPath: string;
	protocol: number;
}

/** Reads the launcher-provided daemon coordinates, if hosted mode is on. */
export function readHostedDaemonEnv(env: NodeJS.ProcessEnv = process.env): HostedDaemonEnv | undefined {
	if (env.MYPI_TUI_HOSTED !== "1") return undefined;
	const socketPath = env.MYPI_DAEMON_SOCKET;
	const protocol = Number(env.MYPI_DAEMON_PROTOCOL);
	if (!socketPath || !Number.isInteger(protocol)) return undefined;
	return { socketPath, protocol };
}

export interface AttachedInfo {
	sessionId: string;
	nativeSessionId: string | null;
	sessionFile: string | null;
	cwd: string;
	clients: number;
}

type Frame = Record<string, unknown> & { type?: string };

interface PendingRequest {
	resolve: (frame: Frame) => void;
	reject: (error: Error) => void;
	timer?: NodeJS.Timeout;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Turn-length operations (compact, navigate_tree, bash) get a long leash. */
const LONG_REQUEST_TIMEOUT_MS = 30 * 60_000;
const LONG_RUNNING_COMMANDS = new Set([
	"compact",
	"navigate_tree",
	"bash",
	"fork",
	"clone",
	"new_session",
	"switch_session",
	"reload",
	"abort",
]);

/**
 * JSONL socket transport with the daemon handshake, request/response
 * correlation, and a single frame listener for everything else (events,
 * extension UI traffic, attached re-broadcasts, session_exit).
 */
export class HostedDaemonClient {
	private readonly env: HostedDaemonEnv;
	private socket: net.Socket | null = null;
	private buffer = "";
	private counter = 0;
	private readonly pending = new Map<string, PendingRequest>();
	private frameListeners = new Set<(frame: Frame) => void>();
	private closed = false;
	/** The session id every routed frame carries; adopted from `attached`. */
	sessionId: string | null = null;

	constructor(env: HostedDaemonEnv) {
		this.env = env;
	}

	get isClosed(): boolean {
		return this.closed;
	}

	async connect(clientName = "mypi-tui"): Promise<void> {
		const socket = net.connect(this.env.socketPath);
		this.socket = socket;
		socket.setNoDelay(true);
		socket.on("data", (data) => this.consume(data.toString()));
		const fail = (error: Error) => this.teardown(error);
		socket.on("error", fail);
		socket.on("close", () => this.teardown(new Error("The MyPi session daemon closed the connection.")));

		await new Promise<void>((resolve, reject) => {
			socket.once("connect", resolve);
			socket.once("error", reject);
		});

		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("The MyPi session daemon did not answer the handshake.")), 10_000);
			const listener = (frame: Frame) => {
				if (frame.type === "hello_ack") {
					clearTimeout(timer);
					this.frameListeners.delete(listener);
					resolve();
				} else if (frame.type === "hello_error") {
					clearTimeout(timer);
					this.frameListeners.delete(listener);
					reject(new Error(String(frame.reason ?? "The daemon refused the handshake.")));
				}
			};
			this.frameListeners.add(listener);
			this.send({ type: "hello", protocol: this.env.protocol, client: clientName });
		});
	}

	/**
	 * Attach to a session (or create a fresh one when sessionId is omitted)
	 * and adopt the id the daemon reports back.
	 */
	attach(options: { sessionId?: string; cwd: string; model?: string }): Promise<AttachedInfo> {
		return new Promise<AttachedInfo>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("Timed out waiting for the session daemon to attach the session.")),
				30_000,
			);
			const listener = (frame: Frame) => {
				if (frame.type === "attached") {
					clearTimeout(timer);
					this.frameListeners.delete(listener);
					this.sessionId = String(frame.sessionId);
					resolve({
						sessionId: String(frame.sessionId),
						nativeSessionId: (frame.nativeSessionId as string | null) ?? null,
						sessionFile: (frame.sessionFile as string | null) ?? null,
						cwd: String(frame.cwd ?? options.cwd),
						clients: Number(frame.clients ?? 1),
					});
				} else if (frame.type === "session_exit") {
					clearTimeout(timer);
					this.frameListeners.delete(listener);
					const notify = frame.lastErrorNotify ? `: ${frame.lastErrorNotify}` : "";
					reject(new Error(`The session engine exited before it became ready${notify}`));
				} else if (frame.type === "error") {
					clearTimeout(timer);
					this.frameListeners.delete(listener);
					reject(new Error(String(frame.error ?? "attach failed")));
				}
			};
			this.frameListeners.add(listener);
			this.send({
				type: "attach",
				...(options.sessionId ? { sessionId: options.sessionId } : {}),
				cwd: options.cwd,
				...(options.model ? { model: options.model } : {}),
			});
		});
	}

	/** Sends a routed command and resolves with its response frame. */
	request<T = Frame>(frame: Frame, options?: { timeoutMs?: number }): Promise<T & Frame> {
		if (this.closed) return Promise.reject(new Error("The daemon connection is closed."));
		this.counter += 1;
		const id = `__tui_${this.counter}`;
		const timeoutMs =
			options?.timeoutMs ??
			(LONG_RUNNING_COMMANDS.has(String(frame.type)) ? LONG_REQUEST_TIMEOUT_MS : DEFAULT_REQUEST_TIMEOUT_MS);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Timed out waiting for the session daemon (${String(frame.type)}).`));
			}, timeoutMs);
			timer.unref?.();
			this.pending.set(id, {
				resolve: (response) => {
					clearTimeout(timer);
					if (response.success === false) {
						reject(new Error(String(response.error ?? `${String(frame.type)} failed`)));
						return;
					}
					resolve(response as T & Frame);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			this.send({ ...frame, id, sessionId: this.sessionId ?? undefined });
		});
	}

	/** Fire-and-forget frame carrying the adopted session id. */
	send(frame: Frame): void {
		if (!this.socket || this.socket.destroyed) return;
		this.socket.write(`${JSON.stringify(frame)}\n`);
	}

	/** Fire-and-forget routed command; errors surface via onFrame error frames. */
	sendCommand(frame: Frame): void {
		this.send({ ...frame, sessionId: this.sessionId ?? undefined });
	}

	onFrame(listener: (frame: Frame) => void): () => void {
		this.frameListeners.add(listener);
		return () => this.frameListeners.delete(listener);
	}

	detach(): void {
		if (this.sessionId) this.send({ type: "detach", sessionId: this.sessionId });
	}

	close(): void {
		this.closed = true;
		this.socket?.destroy();
		this.socket = null;
	}

	private consume(chunk: string): void {
		this.buffer += chunk;
		const lines = this.buffer.split("\n");
		this.buffer = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			let frame: Frame;
			try {
				frame = JSON.parse(line);
			} catch {
				continue;
			}
			this.dispatch(frame);
		}
	}

	private dispatch(frame: Frame): void {
		if (frame.type === "response" && typeof frame.id === "string") {
			const pending = this.pending.get(frame.id);
			if (pending) {
				this.pending.delete(frame.id);
				pending.resolve(frame);
				return;
			}
		}
		// The daemon refuses unroutable commands with an id-carrying error
		// frame; fail the request instead of letting it time out.
		if (frame.type === "error" && typeof frame.id === "string") {
			const pending = this.pending.get(frame.id);
			if (pending) {
				this.pending.delete(frame.id);
				pending.reject(new Error(String(frame.error ?? "The session daemon refused the command.")));
				return;
			}
		}
		for (const listener of [...this.frameListeners]) listener(frame);
	}

	private teardown(error: Error): void {
		if (this.closed) return;
		this.closed = true;
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
		for (const listener of [...this.frameListeners]) listener({ type: "__connection_lost", error: error.message });
	}
}
