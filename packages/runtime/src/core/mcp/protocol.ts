/**
 * MCP JSON-RPC 2.0 message types and newline-delimited STDIO framing
 * (docs/31 decision 4). Owned implementation; no @modelcontextprotocol/*.
 */

import { MCP_LIMITS, McpError } from "./types.ts";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
/** Revisions this client accepts when the server downgrades. */
export const MCP_SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
	"2025-06-18",
	"2025-03-26",
	"2024-11-05",
];

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: JsonRpcId;
	method: string;
	params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: Record<string, unknown>;
}

export interface JsonRpcError {
	code: number;
	message: string;
	data?: unknown;
}

export interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: JsonRpcId;
	result?: Record<string, unknown>;
	error?: JsonRpcError;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_REQUEST = -32600;

export function isResponse(message: JsonRpcMessage): message is JsonRpcResponse {
	return "id" in message && !("method" in message);
}

export function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
	return "id" in message && "method" in message;
}

export function isNotification(message: JsonRpcMessage): message is JsonRpcNotification {
	return !("id" in message) && "method" in message;
}

/** Encode one message as a single newline-terminated UTF-8 line. */
export function encodeMessage(message: JsonRpcMessage, serverId?: string): Buffer {
	const text = JSON.stringify(message);
	if (text.includes("\n") || text.includes("\r")) {
		throw new McpError("MCP_PROTOCOL_ERROR", "MCP STDIO messages must not contain embedded newlines", serverId);
	}
	const payload = Buffer.from(`${text}\n`, "utf8");
	if (payload.byteLength > MCP_LIMITS.maxMessageBytes) {
		throw new McpError("MCP_LIMIT_EXCEEDED", "outbound MCP message exceeds the 4 MiB bound", serverId);
	}
	return payload;
}

/**
 * Incremental newline-delimited JSON reader with a hard buffer bound.
 * Oversized or malformed lines raise instead of silently resynchronizing.
 */
export class JsonRpcReader {
	private buffer = "";
	private readonly serverId?: string;

	constructor(serverId?: string) {
		this.serverId = serverId;
	}

	push(chunk: Buffer | string): JsonRpcMessage[] {
		this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
		if (Buffer.byteLength(this.buffer, "utf8") > MCP_LIMITS.maxBufferedBytes) {
			this.buffer = "";
			throw new McpError("MCP_LIMIT_EXCEEDED", "buffered MCP stdout exceeds the 8 MiB bound", this.serverId);
		}
		const messages: JsonRpcMessage[] = [];
		let newline = this.buffer.indexOf("\n");
		while (newline !== -1) {
			const line = this.buffer.slice(0, newline).replace(/\r$/u, "");
			this.buffer = this.buffer.slice(newline + 1);
			newline = this.buffer.indexOf("\n");
			if (!line.trim()) continue;
			if (Buffer.byteLength(line, "utf8") > MCP_LIMITS.maxMessageBytes) {
				throw new McpError("MCP_LIMIT_EXCEEDED", "inbound MCP message exceeds the 4 MiB bound", this.serverId);
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				throw new McpError("MCP_PROTOCOL_ERROR", "MCP server sent a non-JSON stdout line", this.serverId);
			}
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || (parsed as { jsonrpc?: unknown }).jsonrpc !== "2.0") {
				throw new McpError("MCP_PROTOCOL_ERROR", "MCP server sent a non-JSON-RPC message", this.serverId);
			}
			messages.push(parsed as JsonRpcMessage);
		}
		return messages;
	}
}
