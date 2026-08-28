import { describe, expect, it } from "vitest";
import { TOOL_GROUPS, isToolInDisabledGroup, resolveDisabledToolGroups } from "../src/core/tool-groups.ts";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";

describe("tool groups", () => {
	it("defaults: archive-manage and chat-manage off, everything else on", () => {
		const disabled = resolveDisabledToolGroups(undefined, undefined);
		expect([...disabled].sort()).toEqual(["archive-manage", "chat-manage"]);
	});

	it("enabled exceptions turn default-off groups on; disabled exceptions stack", () => {
		const disabled = resolveDisabledToolGroups(["shell", "web"], ["archive-manage"]);
		expect(disabled.has("archive-manage")).toBe(false);
		expect(disabled.has("chat-manage")).toBe(true);
		expect(disabled.has("shell")).toBe(true);
		expect(disabled.has("web")).toBe(true);
	});

	it("membership honors exact names, workspace variants, and mcp prefixes", () => {
		const disabled = resolveDisabledToolGroups(["workspace-read", "file-editing", "mcp"], []);
		expect(isToolInDisabledGroup("read", disabled)).toBe(true);
		expect(isToolInDisabledGroup("read_workspace", disabled)).toBe(true);
		expect(isToolInDisabledGroup("write_workspace", disabled)).toBe(true);
		expect(isToolInDisabledGroup("mcp_search", disabled)).toBe(true);
		expect(isToolInDisabledGroup("mcp_fixture_echo", disabled)).toBe(true);
		expect(isToolInDisabledGroup("bash", disabled)).toBe(false);
	});

	it("unknown group ids are tolerated", () => {
		const disabled = resolveDisabledToolGroups(["future-group"], ["also-unknown"]);
		expect(isToolInDisabledGroup("read", disabled)).toBe(false);
	});

	it("every group id is unique and every tool belongs to exactly one group", () => {
		const ids = TOOL_GROUPS.map((group) => group.id);
		expect(new Set(ids).size).toBe(ids.length);
		const seen = new Map<string, string>();
		for (const group of TOOL_GROUPS) {
			for (const tool of group.tools) {
				expect(seen.has(tool), `${tool} in ${seen.get(tool)} and ${group.id}`).toBe(false);
				seen.set(tool, group.id);
			}
		}
	});
});

describe("system prompt honors disabled tools", () => {
	it("drops shell/editing guidance and destructive-actions without those tools", () => {
		const prompt = buildSystemPrompt({ cwd: "/tmp/prompt-test", selectedTools: ["commentary"] });
		expect(prompt).not.toMatch(/Reserve `bash`/);
		expect(prompt).not.toMatch(/shell redirection/);
		expect(prompt).not.toMatch(/# Destructive actions/);
		expect(prompt).not.toMatch(/shell chaining/);
	});

	it("keeps guidance when the tools exist", () => {
		const prompt = buildSystemPrompt({ cwd: "/tmp/prompt-test", selectedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"] });
		expect(prompt).toMatch(/Prefer built-in tools over shell commands/);
		expect(prompt).toMatch(/# Destructive actions/);
		expect(prompt).toMatch(/shell chaining/);
	});

	it("bash-only sessions keep shell guidance without read-tool comparisons", () => {
		const prompt = buildSystemPrompt({ cwd: "/tmp/prompt-test", selectedTools: ["bash"] });
		expect(prompt).toMatch(/Reserve `bash` for actually running things/);
		expect(prompt).not.toMatch(/Prefer built-in tools over shell commands/);
	});
});
