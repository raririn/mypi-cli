/**
 * STDIO transport: sanitized spawn, framed message IO, bounded stderr ring,
 * and complete process-group teardown (docs/31 section 7).
 *
 * Deviation confirmed 2026-08-21: `node:child_process.spawn` with
 * `shell: false`, matching the subagent RpcClient pattern, instead of a new
 * `cross-spawn` dependency.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { MCP_LIMITS, McpError, type McpServerConfig } from "./types.ts";
import { buildChildEnv } from "./config.ts";
import { encodeMessage, JsonRpcReader, type JsonRpcMessage } from "./protocol.ts";

export interface McpTransportEvents {
	onMessage: (message: JsonRpcMessage) => void;
	onProtocolError: (error: McpError) => void;
	onExit: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
}

export class McpStdioTransport {
	private readonly config: McpServerConfig;
	private readonly child: ChildProcess;
	private readonly reader: JsonRpcReader;
	private stderrRing = "";
	private exited = false;
	private stopped = false;

	private constructor(config: McpServerConfig, child: ChildProcess, events: McpTransportEvents) {
		this.config = config;
		this.child = child;
		this.reader = new JsonRpcReader(config.serverId);
		child.stdout?.on("data", (chunk: Buffer) => {
			let messages: JsonRpcMessage[];
			try {
				messages = this.reader.push(chunk);
			} catch (error) {
				events.onProtocolError(error instanceof McpError ? error : new McpError("MCP_PROTOCOL_ERROR", String(error), config.serverId));
				void this.stop();
				return;
			}
			for (const message of messages) events.onMessage(message);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			this.stderrRing = `${this.stderrRing}${chunk.toString("utf8")}`.slice(-MCP_LIMITS.stderrRingBytes);
		});
		child.on("exit", (code, signal) => {
			this.exited = true;
			events.onExit({ code, signal });
		});
		child.on("error", () => {
			// Spawn/stream errors surface through exit handling; keep teardown idempotent.
			if (!this.exited) {
				this.exited = true;
				events.onExit({ code: null, signal: null });
			}
		});
	}

	static start(config: McpServerConfig, cwd: string, events: McpTransportEvents): McpStdioTransport {
		const env = buildChildEnv(config, process.env);
		let child: ChildProcess;
		try {
			child = spawn(config.command, [...config.args], {
				cwd,
				env,
				stdio: ["pipe", "pipe", "pipe"],
				shell: false,
				// POSIX: a fresh process group so teardown addresses descendants.
				detached: process.platform !== "win32",
			});
		} catch (error) {
			throw new McpError("MCP_SERVER_UNAVAILABLE", `failed to spawn MCP server: ${error instanceof Error ? error.message : String(error)}`, config.serverId);
		}
		return new McpStdioTransport(config, child, events);
	}

	get pid(): number | undefined {
		return this.child.pid ?? undefined;
	}

	get alive(): boolean {
		return !this.exited && this.child.pid !== undefined;
	}

	/** Redacted bounded stderr tail; never model-visible by default. */
	get stderrTail(): string {
		return this.stderrRing;
	}

	send(message: JsonRpcMessage): void {
		if (this.exited || !this.child.stdin || this.child.stdin.destroyed) {
			throw new McpError("MCP_SERVER_UNAVAILABLE", "MCP server stdin is closed", this.config.serverId);
		}
		this.child.stdin.write(encodeMessage(message, this.config.serverId));
	}

	/** SIGTERM the process group, wait two seconds, then SIGKILL. Idempotent. */
	async stop(): Promise<void> {
		if (this.stopped) {
			await this.waitForExit(2_500);
			return;
		}
		this.stopped = true;
		if (this.exited || this.child.pid === undefined) return;
		this.child.stdin?.end();
		this.signalTree("SIGTERM");
		const clean = await this.waitForExit(2_000);
		if (!clean) {
			this.signalTree("SIGKILL");
			await this.waitForExit(2_000);
		}
	}

	private signalTree(signal: NodeJS.Signals): void {
		const pid = this.child.pid;
		if (pid === undefined) return;
		try {
			if (process.platform === "win32") {
				this.child.kill(signal);
			} else {
				process.kill(-pid, signal);
			}
		} catch {
			try {
				this.child.kill(signal);
			} catch {
				// Already gone.
			}
		}
	}

	private waitForExit(timeoutMs: number): Promise<boolean> {
		if (this.exited) return Promise.resolve(true);
		return new Promise((resolve) => {
			const timer = setTimeout(() => resolve(this.exited), timeoutMs);
			timer.unref?.();
			this.child.once("exit", () => {
				clearTimeout(timer);
				resolve(true);
			});
		});
	}
}
