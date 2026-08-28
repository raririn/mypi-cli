/**
 * Togglable tool groups (Settings → Tools).
 *
 * Every session tool belongs to exactly one group; `shared.tools.disabled`
 * (config.yaml) lists the group ids a user turned off. The set is captured
 * once at session creation — like tools.mode — so a change applies to new
 * sessions only and never busts a live session's prompt cache (FEAT-088).
 *
 * Un-dividable tools share one group: disabling "workspace-read" removes the
 * whole read surface including the bounded-mode read_workspace substitute,
 * and "mcp" covers the gateway plus every dynamically loaded mcp_* tool.
 *
 * Deliberately ungrouped (never disable-able from here): exec_code (owned by
 * tools.mode), the chat profile's canvas/attachment tools (the chat surface
 * is a separate curated profile), advisor_evidence (internal to advisor
 * subagent sessions), and generate_image (owned by imageGen.provider — its
 * Settings → Tools entry drives that field).
 */

export interface ToolGroup {
	readonly id: string;
	readonly label: string;
	readonly description: string;
	/** Exact tool names owned by this group. */
	readonly tools: readonly string[];
	/** Tool-name prefixes owned by this group (dynamic families). */
	readonly prefixes?: readonly string[];
	/** Groups disabled unless explicitly enabled (absent from tools.disabled
	 *  means DEFAULT; the config stores exceptions in both directions via
	 *  `tools.disabled` and `tools.enabled`). */
	readonly defaultEnabled: boolean;
}

export const TOOL_GROUPS: readonly ToolGroup[] = [
	{
		id: "workspace-read",
		label: "Workspace read",
		description: "read, grep, find, ls (and the sandboxed read_workspace variant)",
		tools: ["read", "grep", "find", "ls", "read_workspace"],
		defaultEnabled: true,
	},
	{
		id: "file-editing",
		label: "File editing",
		description: "edit, write (and the sandboxed write_workspace variant)",
		tools: ["edit", "write", "write_workspace"],
		defaultEnabled: true,
	},
	{
		id: "shell",
		label: "Shell",
		description: "bash command execution",
		tools: ["bash"],
		defaultEnabled: true,
	},
	{
		id: "web",
		label: "Web access",
		description: "web_search and web_fetch",
		tools: ["web_search", "web_fetch"],
		defaultEnabled: true,
	},
	{
		id: "ask-user",
		label: "Ask user",
		description: "structured ask_user questions",
		tools: ["ask_user"],
		defaultEnabled: true,
	},
	{
		id: "commentary",
		label: "Commentary",
		description: "inline progress commentary",
		tools: ["commentary", "deep_thinking"],
		defaultEnabled: true,
	},
	{
		id: "checkpoints",
		label: "Checkpoints & recall",
		description: "session checkpoints and compacted-history recall",
		tools: ["checkpoint", "recall_compacted_history"],
		defaultEnabled: true,
	},
	{
		id: "goals",
		label: "Goals & plans",
		description: "structured goal/plan tools",
		tools: ["get_goal", "get_goal_plan", "create_goal", "set_goal_plan", "update_goal_plan", "update_goal"],
		defaultEnabled: true,
	},
	{
		id: "subagents",
		label: "Subagents",
		description: "explore/advisor/reviewer delegation",
		tools: [
			"subagent_start",
			"consult_advisor",
			"ask_for_review",
			"subagent_followup",
			"advisor_followup",
			"reviewer_followup",
			"subagent_cancel",
			"subagent_status",
		],
		defaultEnabled: true,
	},
	{
		id: "mcp",
		label: "MCP",
		description: "the MCP gateway and every loaded server tool",
		tools: ["mcp_search", "mcp_load", "mcp_read_resource"],
		prefixes: ["mcp_"],
		defaultEnabled: true,
	},
	{
		id: "status",
		label: "Status & notifications",
		description: "set_status and notify_user",
		tools: ["set_status", "notify_user"],
		defaultEnabled: true,
	},
	{
		id: "wakeups",
		label: "Wakeups & watches",
		description: "schedule_wakeup and watch_files",
		tools: ["schedule_wakeup", "watch_files"],
		defaultEnabled: true,
	},
	{
		id: "archive-manage",
		label: "Archive management",
		description: "session archive/compaction/deletion tools (formerly the /archive-manage grant)",
		tools: [
			"session_archive_stats",
			"list_session_archives",
			"inspect_session_archive",
			"archive_session",
			"compact_session_history",
			"archive_sessions_older_than",
			"archive_sessions_with_max_user_messages",
			"restore_archived_session",
			"delete_archived_session",
			"delete_archived_sessions_older_than",
			"delete_archived_sessions_with_max_user_messages",
			"delete_orphaned_session",
		],
		defaultEnabled: false,
	},
	{
		id: "chat-manage",
		label: "Chat management",
		description: "PiChat storage maintenance tools (formerly the /chat-manage grant)",
		tools: ["list_chats", "inspect_chat_storage", "archive_chat", "restore_chat", "erase_chat_assets", "delete_archived_chat"],
		defaultEnabled: false,
	},
];

const GROUP_BY_ID = new Map(TOOL_GROUPS.map((group) => [group.id, group]));

export function isKnownToolGroup(id: string): boolean {
	return GROUP_BY_ID.has(id);
}

/**
 * The effective disabled-group set: defaults, minus `enabled` exceptions,
 * plus `disabled` exceptions. Unknown ids are tolerated (forward compat).
 */
export function resolveDisabledToolGroups(
	disabled: readonly string[] | undefined,
	enabled: readonly string[] | undefined,
): ReadonlySet<string> {
	const result = new Set<string>();
	for (const group of TOOL_GROUPS) {
		if (!group.defaultEnabled) result.add(group.id);
	}
	for (const id of enabled ?? []) result.delete(id);
	for (const id of disabled ?? []) result.add(id);
	return result;
}

/** Membership test honoring exact names and dynamic prefixes. */
export function isToolInDisabledGroup(toolName: string, disabledGroups: ReadonlySet<string>): boolean {
	for (const id of disabledGroups) {
		const group = GROUP_BY_ID.get(id);
		if (!group) continue;
		if (group.tools.includes(toolName)) return true;
		if (group.prefixes?.some((prefix) => toolName.startsWith(prefix))) return true;
	}
	return false;
}
