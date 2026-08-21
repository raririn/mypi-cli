import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import {
	createSubagentBatchId,
	createSubagentChildId,
	createSubagentGrantId,
	isOpaqueSubagentId,
	SubagentStore,
	type SubagentChildRecord,
} from "../../src/core/subagents/storage.ts";
import subagentsExtension, {
	SUBAGENT_CANCEL_TOOL,
	SUBAGENT_FOLLOWUP_TOOL,
	SUBAGENT_ROLE_PROMPTS,
	SUBAGENT_START_TOOL,
	SUBAGENT_STATUS_TOOL,
	SubagentManager,
} from "../../src/product/subagents.ts";

function childRecord(parentSessionId: string): SubagentChildRecord {
	const now = new Date().toISOString();
	return {
		version: 1,
		childId: createSubagentChildId(),
		parentSessionId,
		parentBranchId: null,
		role: "review",
		label: "Review the final change",
		task: "Review the current diff.",
		cwd: process.cwd(),
		model: { provider: "test", id: "model" },
		createdAt: now,
		updatedAt: now,
		grants: [{
			grantId: createSubagentGrantId(),
			batchId: createSubagentBatchId(),
			prompt: "Review the current diff.",
			status: "queued",
			createdAt: now,
		}],
	};
}

test("subagent IDs are opaque program-generated capabilities", () => {
	for (const [prefix, factory] of [["sb", createSubagentBatchId], ["sa", createSubagentChildId], ["sg", createSubagentGrantId]] as const) {
		const values = new Set(Array.from({ length: 128 }, factory));
		assert.equal(values.size, 128);
		for (const value of values) assert.equal(isOpaqueSubagentId(value, prefix), true);
	}
	assert.equal(isOpaqueSubagentId("sa_agent-chosen-id", "sa"), false);
});

test("subagent storage is structured, inspectable, contained, and symlink-safe", async () => {
	const root = await mkdtemp(join(tmpdir(), "mypi-subagents-"));
	const agentDir = join(root, "agent");
	const parentSessionId = "019-parent-session";
	try {
		const store = await SubagentStore.open(agentDir, parentSessionId);
		const record = childRecord(parentSessionId);
		await store.create(record);
		const sessionPath = store.childSessionPath(record.childId);
		assert.equal((await lstat(sessionPath)).isFile(), true);
		assert.equal((await readFile(sessionPath)).length, 0);
		const metadata = JSON.parse(await readFile(join(store.childDirectory(record.childId), "metadata.json"), "utf8"));
		const manifest = JSON.parse(await readFile(store.manifestPath, "utf8"));
		assert.equal(metadata.childId, record.childId);
		assert.equal(manifest.children[0].task, "Review the current diff.");
		if (process.platform !== "win32") assert.equal((await lstat(store.manifestPath)).mode & 0o777, 0o600);

		await rm(store.manifestPath);
		const outside = join(root, "outside.json");
		await writeFile(outside, "{}\n");
		await symlink(outside, store.manifestPath);
		await assert.rejects(SubagentStore.open(agentDir, parentSessionId), /unsafe|oversized/i);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("sealed subagent tools expose homogeneous async jobs and distinct barebones advisor/reviewer roles", async () => {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const handlers = new Map<string, any[]>();
	const pi = {
		events: { on() { return () => {}; }, emit() {} },
		registerTool(tool: any) { tools.set(tool.name, tool); },
		registerCommand(name: string, command: any) { commands.set(name, command); },
		on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
	} as unknown as ExtensionAPI;
	subagentsExtension(pi);
	assert.deepEqual([...tools.keys()], [SUBAGENT_START_TOOL, SUBAGENT_FOLLOWUP_TOOL, SUBAGENT_CANCEL_TOOL, SUBAGENT_STATUS_TOOL]);
	assert.deepEqual([...commands.keys()], ["advisor-model", "advisor", "reviewer"]);
	assert.match(tools.get(SUBAGENT_START_TOOL).description, /Mixed job roles are prohibited/);
	assert.match(tools.get(SUBAGENT_START_TOOL).description, /blocks your edit, write, and Bash/);
	assert.notEqual(SUBAGENT_ROLE_PROMPTS.advisor, SUBAGENT_ROLE_PROMPTS.review);
	assert.match(SUBAGENT_ROLE_PROMPTS.advisor, /read-only MyPi advisor/i);
	assert.match(SUBAGENT_ROLE_PROMPTS.review, /read-only MyPi code reviewer/i);

	const schema = tools.get(SUBAGENT_START_TOOL).parameters;
	assert.equal(schema.properties.jobs.items.properties.childId, undefined, "the model cannot supply child identity");

	const ctx = {
		cwd: process.cwd(),
		isProjectTrusted: () => true,
		sessionManager: {
			getSessionFile: () => join(tmpdir(), "parent.jsonl"),
			getSessionId: () => "parent-test-session",
			getLeafId: () => null,
			getBranch: () => [],
		},
	} as any;
	await assert.rejects(
		tools.get(SUBAGENT_START_TOOL).execute("call", {
			jobs: [
				{ role: "explore", label: "Explore", task: "Inspect A" },
				{ role: "review", label: "Review", task: "Review B" },
			],
		}, undefined, undefined, ctx),
		/Mixed subagent job roles are prohibited/,
	);
});

test("advisor and reviewer mandatory prompts are independent and absent by default", () => {
	const manager = new SubagentManager({
		getActiveTools: () => [SUBAGENT_START_TOOL],
		sendMessage() {},
	} as unknown as ExtensionAPI);
	assert.deepEqual(manager.parentPromptSections(), []);
	manager.setRequirements(true, false);
	assert.equal(manager.parentPromptSections().length, 1);
	assert.match(manager.parentPromptSections()[0]!, /Mandatory advisor consultation/);
	assert.doesNotMatch(manager.parentPromptSections()[0]!, /Mandatory final review/);
	manager.setRequirements(false, true);
	assert.equal(manager.parentPromptSections().length, 1);
	assert.match(manager.parentPromptSections()[0]!, /Mandatory final review/);
	manager.setRequirements(true, true);
	assert.equal(manager.parentPromptSections().length, 2);
});

test("user commands persist and dynamically switch separate mandatory prompts", async () => {
	const commands = new Map<string, any>();
	const handlers = new Map<string, any[]>();
	const entries: unknown[] = [];
	const notices: string[] = [];
	const pi = {
		events: { on() { return () => {}; }, emit() {} },
		registerTool() {},
		registerCommand(name: string, command: any) { commands.set(name, command); },
		on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		getActiveTools: () => [SUBAGENT_START_TOOL],
		appendEntry(customType: string, data: unknown) { entries.push({ customType, data }); },
		sendMessage() {},
	} as unknown as ExtensionAPI;
	subagentsExtension(pi);
	const ctx = {
		ui: { notify(message: string) { notices.push(message); } },
		isIdle: () => true,
	} as any;
	await commands.get("advisor").handler("on", ctx);
	const advisorPrompt = await handlers.get("before_agent_start")?.[0]({ systemPrompt: "base" }, ctx);
	assert.match(advisorPrompt.systemPrompt, /Mandatory advisor consultation/);
	assert.doesNotMatch(advisorPrompt.systemPrompt, /Mandatory final review/);
	await commands.get("reviewer").handler("on", ctx);
	const both = await handlers.get("before_agent_start")?.[0]({ systemPrompt: "base" }, ctx);
	assert.match(both.systemPrompt, /Mandatory advisor consultation/);
	assert.match(both.systemPrompt, /Mandatory final review/);
	await commands.get("advisor").handler("off", ctx);
	const reviewerOnly = await handlers.get("before_agent_start")?.[0]({ systemPrompt: "base" }, ctx);
	assert.doesNotMatch(reviewerOnly.systemPrompt, /Mandatory advisor consultation/);
	assert.match(reviewerOnly.systemPrompt, /Mandatory final review/);
	assert.equal(entries.length, 3);
	assert.equal(notices.length, 3);
});

test("subagent admission inherits trust, no-read, readonly, and planning restrictions", async () => {
	const manager = new SubagentManager({ sendMessage() {} } as unknown as ExtensionAPI);
	const base = {
		cwd: process.cwd(),
		model: { provider: "test", id: "model" },
		thinkingLevel: "off",
		isProjectTrusted: () => true,
		isIdle: () => true,
		sessionManager: {
			getSessionFile: () => join(tmpdir(), "parent-policy.jsonl"),
			getSessionId: () => "parent-policy-session",
			getLeafId: () => null,
			getBranch: () => [],
		},
	} as any;
	manager.setAccessMode("noread");
	await assert.rejects(manager.start([{ role: "explore", label: "Read", task: "Inspect" }], base), /No-read/);
	manager.setAccessMode("readonly");
	await assert.rejects(manager.start([{ role: "work", label: "Write", task: "Edit" }], base), /Read-only/);
	manager.setAccessMode(undefined);
	await assert.rejects(manager.start([{ role: "work", label: "Write", task: "Edit" }], {
		...base,
		sessionManager: {
			...base.sessionManager,
			getBranch: () => [{ type: "custom", customType: "mypi-goal", data: { workflow: "planning" } }],
		},
	}), /Planning mode/);
	await assert.rejects(manager.start([{ role: "review", label: "Review", task: "Review" }], {
		...base,
		isProjectTrusted: () => false,
	}), /trusted project/);
});

test("work-child guard requires sandboxed Bash and blocks direct protected-metadata writes", () => {
	const previous = process.env.MYPI_SUBAGENT_CHILD;
	process.env.MYPI_SUBAGENT_CHILD = "work";
	const handlers = new Map<string, any[]>();
	const pi = {
		on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		getSafetyState: () => ({ effective: "sandbox", enabled: true }),
	} as unknown as ExtensionAPI;
	try {
		subagentsExtension(pi);
		const guard = handlers.get("tool_call")?.[0];
		assert.ok(guard);
		assert.match(guard({ toolName: "write", input: { path: ".git/config" } }, { cwd: process.cwd() }).reason, /protected/);
		assert.match(guard({ toolName: "edit", input: { path: ".mypi/settings.json" } }, { cwd: process.cwd() }).reason, /protected/);
		assert.equal(guard({ toolName: "write", input: { path: "src/ok.ts" } }, { cwd: process.cwd() }), undefined);
		(pi.getSafetyState as any) = () => ({ effective: "full", enabled: true });
		assert.match(guard({ toolName: "bash", input: { command: "pwd" } }, { cwd: process.cwd() }).reason, /mandatory sandbox/);
	} finally {
		if (previous === undefined) delete process.env.MYPI_SUBAGENT_CHILD;
		else process.env.MYPI_SUBAGENT_CHILD = previous;
	}
});
