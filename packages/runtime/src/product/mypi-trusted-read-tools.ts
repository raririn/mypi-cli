import type { ExtensionAPI } from "../core/extensions/types.ts";
import { hasProductAuthority } from "../core/source-info.ts";

const BUILTIN_READ_TOOLS = new Set(["read", "grep", "find", "ls", "read_workspace"]);
const MYPI_WEB_READ_TOOLS = new Set(["web_search", "web_fetch"]);
const MYPI_SESSION_READ_TOOLS = new Set(["recall_compacted_history"]);
const MYPI_USER_INTERACTION_TOOLS = new Set(["ask_user"]);
const MYPI_SUBAGENT_READ_TOOLS = new Set(["subagent_start", "consult_advisor", "ask_for_review", "subagent_followup", "advisor_followup", "reviewer_followup", "subagent_cancel", "subagent_status", "advisor_evidence"]);
const MYPI_SUBAGENT_CONTROL_TOOLS = new Set(["subagent_cancel", "subagent_status"]);

export function isTrustedWebReadTool(pi: ExtensionAPI, toolName: string): boolean {
	if (!MYPI_WEB_READ_TOOLS.has(toolName)) return false;
	const tool = pi.getAllTools().find((candidate) => candidate.name === toolName);
	return hasProductAuthority(tool?.sourceInfo, ["capability"]);
}

export function isTrustedUserInteractionTool(pi: ExtensionAPI, toolName: string): boolean {
	if (!MYPI_USER_INTERACTION_TOOLS.has(toolName) && !MYPI_SUBAGENT_CONTROL_TOOLS.has(toolName)) return false;
	const tool = pi.getAllTools().find((candidate) => candidate.name === toolName);
	return hasProductAuthority(tool?.sourceInfo, ["capability"]);
}

export function isTrustedReadOnlyTool(pi: ExtensionAPI, toolName: string): boolean {
	const tool = pi.getAllTools().find((candidate) => candidate.name === toolName);
	if (!tool) return false;
	if (BUILTIN_READ_TOOLS.has(toolName)) return tool.sourceInfo.source === "builtin";
	if (MYPI_SESSION_READ_TOOLS.has(toolName)) return hasProductAuthority(tool.sourceInfo, ["required"]);
	if (MYPI_SUBAGENT_READ_TOOLS.has(toolName)) return hasProductAuthority(tool.sourceInfo, ["capability"]);
	return isTrustedWebReadTool(pi, toolName) || isTrustedUserInteractionTool(pi, toolName);
}
