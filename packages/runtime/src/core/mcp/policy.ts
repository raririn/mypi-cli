/**
 * Code-owned MCP policy: effect classification plus the complete
 * safety/read/plan/trust enforcement matrix (docs/31 section 6).
 * No layer can grant a call another layer rejected.
 */

import { ruleAllows } from "./config.ts";
import type { McpEffect, McpServerConfig, McpToolPolicyEntry } from "./types.ts";

/** Configuration classifies effects; server prose never grants policy. */
export function classifyTool(config: McpServerConfig, remoteName: string): McpToolPolicyEntry {
	return config.toolPolicy[remoteName] ?? { effect: "unknown", allowInPlan: false };
}

export function toolRuleAllows(config: McpServerConfig, remoteName: string): boolean {
	return ruleAllows(config.toolAllow, config.toolDeny, remoteName);
}

export function resourceRuleAllows(config: McpServerConfig, uri: string): boolean {
	return ruleAllows(config.resourceAllow, config.resourceDeny, uri);
}

export type McpSafetyMode = "safe" | "sandbox" | "sandbox-ask" | "ask" | "full";

export interface McpPolicyState {
	readonly safetyMode: McpSafetyMode;
	readonly accessMode?: "readonly" | "noread";
	readonly planning: boolean;
	readonly projectTrusted: boolean;
}

export type McpActionKind = "start" | "call" | "read-resource";

export interface McpPolicyDecision {
	readonly allow: boolean;
	readonly requireApproval: boolean;
	readonly reason?: string;
}

/**
 * Evaluate one live MCP action. Static configured-ID search never reaches
 * this gate; everything that starts a process or talks to one does.
 */
export function evaluateMcpAction(
	kind: McpActionKind,
	server: McpServerConfig,
	state: McpPolicyState,
	tool?: { readonly remoteName: string; readonly effect: McpEffect; readonly allowInPlan: boolean },
): McpPolicyDecision {
	const block = (reason: string): McpPolicyDecision => ({ allow: false, requireApproval: false, reason });

	if (!server.enabled) return block(`MCP server ${server.serverId} is disabled`);

	// Untrusted projects: project servers and non-opted-in global servers stay cold.
	if (!state.projectTrusted) {
		if (server.configScope === "project") return block("project-defined MCP servers require project trust");
		if (!server.allowUntrustedProjects) {
			return block(`global MCP server ${server.serverId} does not allow untrusted projects`);
		}
	}

	// /noread blocks server start, catalog collection, resources, and all tools.
	if (state.accessMode === "noread") return block("no-read mode blocks live MCP interaction");

	// Safety mode row: safe and sandbox block live MCP entirely.
	if (state.safetyMode === "safe") return block("Safe mode blocks live MCP interaction; MCP servers are external executable authority");
	if (state.safetyMode === "sandbox") return block("Sandboxed mode blocks live MCP interaction; STDIO servers run outside the Bash sandbox");
	const requireApproval = state.safetyMode === "ask" || state.safetyMode === "sandbox-ask";

	if (kind === "start") return { allow: true, requireApproval };

	// Read-only and planning rows intersect for tool calls.
	if (kind === "call") {
		const effect = tool?.effect ?? "unknown";
		if (state.accessMode === "readonly" && effect !== "read") {
			return block(`read-only mode permits only tools classified read; ${tool?.remoteName ?? "tool"} is ${effect}`);
		}
		if (state.planning && (effect !== "read" || tool?.allowInPlan !== true)) {
			return block(`planning permits only read tools with allowInPlan: true; ${tool?.remoteName ?? "tool"} is not granted`);
		}
	}

	// Resources are reads; planning and readonly permit them.
	return { allow: true, requireApproval };
}
