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
	ADVISOR_FOLLOWUP_TOOL,
	ASK_FOR_REVIEW_TOOL,
	CONSULT_ADVISOR_TOOL,
	REVIEWER_FOLLOWUP_TOOL,
	SUBAGENT_CANCEL_TOOL,
	SUBAGENT_FOLLOWUP_TOOL,
	SUBAGENT_ROLE_PROMPTS,
	SUBAGENT_START_TOOL,
	SUBAGENT_STATUS_TOOL,
	SubagentManager,
} from "../../src/product/subagents.ts";
import {
	ADVISOR_BRIEF_PROMPT,
	ADVISOR_PROMPT,
	ADVISOR_REPLACEMENT_CONFIRMATION_PROMPT,
	PARENT_ADVISOR_REQUIRED_PROMPT,
	PARENT_REVIEWER_REQUIRED_PROMPT,
	REVIEWER_DEFAULT_PROMPT,
	REVIEWER_ENVELOPE_PROMPT,
	REVIEWER_REPLACEMENT_CONFIRMATION_PROMPT,
} from "../../src/product/subagent-prompts.ts";

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

test("delegation, advisor, and reviewer expose distinct asynchronous tool calls", async () => {
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
	assert.deepEqual([...tools.keys()], [SUBAGENT_START_TOOL, CONSULT_ADVISOR_TOOL, ASK_FOR_REVIEW_TOOL, SUBAGENT_FOLLOWUP_TOOL, ADVISOR_FOLLOWUP_TOOL, REVIEWER_FOLLOWUP_TOOL, SUBAGENT_CANCEL_TOOL, SUBAGENT_STATUS_TOOL]);
	assert.deepEqual([...commands.keys()], ["advisor-model", "advisor", "reviewer"]);
	assert.match(tools.get(SUBAGENT_START_TOOL).description, /explore or work/);
	assert.match(tools.get(SUBAGENT_START_TOOL).description, /consult_advisor/);
	assert.match(tools.get(SUBAGENT_START_TOOL).description, /ask_for_review/);
	assert.match(tools.get(SUBAGENT_START_TOOL).description, /blocks your edit, write, and Bash/);
	assert.match(tools.get(CONSULT_ADVISOR_TOOL).description, /advisor consultation/i);
	assert.match(tools.get(ASK_FOR_REVIEW_TOOL).description, /code review/i);
	assert.notEqual(SUBAGENT_ROLE_PROMPTS.advisor, SUBAGENT_ROLE_PROMPTS.review);
	assert.match(SUBAGENT_ROLE_PROMPTS.advisor, /MyPi's independent advisor/i);
	assert.match(SUBAGENT_ROLE_PROMPTS.review, /MyPi's independent code reviewer/i);

	const schema = tools.get(SUBAGENT_START_TOOL).parameters;
	assert.equal(schema.properties.jobs.items.properties.childId, undefined, "the model cannot supply child identity");
	assert.deepEqual(schema.properties.jobs.items.properties.role.anyOf.map((entry: any) => entry.const), ["explore", "work"]);
	assert.deepEqual(Object.keys(tools.get(CONSULT_ADVISOR_TOOL).parameters.properties), ["question"]);
	assert.deepEqual(Object.keys(tools.get(ASK_FOR_REVIEW_TOOL).parameters.properties), ["request"]);
	assert.deepEqual(Object.keys(tools.get(SUBAGENT_FOLLOWUP_TOOL).parameters.properties), ["childId", "prompt"]);
	assert.deepEqual(Object.keys(tools.get(ADVISOR_FOLLOWUP_TOOL).parameters.properties), ["question"]);
	assert.deepEqual(Object.keys(tools.get(REVIEWER_FOLLOWUP_TOOL).parameters.properties), ["request"]);

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
			jobs: [{ role: "review", label: "Review", task: "Review B" }],
		}, undefined, undefined, ctx),
		/Route advice to consult_advisor and review to ask_for_review/,
	);
});

test("follow-up calls enforce the stored child role", async () => {
	const review = childRecord("parent-role-routing");
	const manager = new SubagentManager({ sendMessage() {} } as unknown as ExtensionAPI);
	(manager as any).initialize = async () => {};
	(manager as any).store = {
		get: (childId: string) => childId === review.childId ? review : undefined,
		list: () => [review],
	};
	const ctx = {} as any;
	await assert.rejects(manager.followup(review.childId, "Continue", ctx), /reviewer_followup/);
	await assert.rejects(manager.advisorFollowup("Continue", ctx), /requires a previous consult_advisor/);
	(manager as any).active.set(review.childId, { record: review });
	await assert.rejects(manager.reviewerFollowup("Continue", ctx), /Reviewer conversation already active/);
	review.role = "advisor";
	await assert.rejects(manager.followup(review.childId, "Continue", ctx), /advisor_followup/);
	await assert.rejects(manager.advisorFollowup("Continue", ctx), /Advisor conversation already active/);
	await assert.rejects(manager.reviewerFollowup("Continue", ctx), /requires a previous ask_for_review/);
});

test("fresh consultation replacement requires an exact repeated objective", async () => {
	const advisor = childRecord("parent-replacement-routing");
	advisor.role = "advisor";
	const manager = new SubagentManager({ sendMessage() {} } as unknown as ExtensionAPI);
	(manager as any).initialize = async () => {};
	(manager as any).store = { list: () => [advisor] };
	const admitted: unknown[] = [];
	(manager as any).startJobs = async (jobs: unknown[]) => {
		admitted.push(jobs);
		return { batchId: "sb_replacement", jobs: [{ childId: "sa_replacement", grantId: "sg_replacement", role: "advisor", status: "queued" }] };
	};
	// Confirmed replacement preflights availability before touching the predecessor.
	(manager as any).resolveModel = async () => ({ provider: "test", id: "model" });
	const ctx = {} as any;
	const first = await manager.consultAdvisor("New objective A", ctx);
	assert.equal(first.confirmationRequired, true);
	assert.equal((first as any).message, ADVISOR_REPLACEMENT_CONFIRMATION_PROMPT);
	const changed = await manager.consultAdvisor("New objective B", ctx);
	assert.equal(changed.confirmationRequired, true, "a changed objective requires its own confirmation");
	const confirmed = await manager.consultAdvisor("New objective B", ctx);
	assert.equal(confirmed.confirmationRequired, false);
	assert.equal(admitted.length, 1);
	const epochFirst = await manager.consultAdvisor("New objective C", ctx);
	assert.equal(epochFirst.confirmationRequired, true);
	manager.recordUserEpoch();
	const epochReset = await manager.consultAdvisor("New objective C", ctx);
	assert.equal(epochReset.confirmationRequired, true, "new user input clears replacement confirmation");
	assert.equal(admitted.length, 1);
	const originalNow = Date.now;
	let now = originalNow();
	Date.now = () => now;
	try {
		await manager.consultAdvisor("New objective D", ctx);
		now += 120_001;
		const expired = await manager.consultAdvisor("New objective D", ctx);
		assert.equal(expired.confirmationRequired, true, "expired confirmation requires another exact call");
		assert.equal(admitted.length, 1);
	} finally {
		Date.now = originalNow;
	}
});

test("confirmed replacement settles the running consultation before admission", async () => {
	const advisor = childRecord("parent-active-replacement");
	advisor.role = "advisor";
	const manager = new SubagentManager({ sendMessage() {} } as unknown as ExtensionAPI);
	(manager as any).initialize = async () => {};
	(manager as any).store = { list: () => [advisor] };
	const running = { record: advisor };
	(manager as any).active.set(advisor.childId, running);
	const reasons: string[] = [];
	(manager as any).cancelRunning = async (_running: unknown, reason: string) => {
		reasons.push(reason);
		(manager as any).active.delete(advisor.childId);
	};
	(manager as any).startJobs = async () => ({ batchId: "sb_new", jobs: [{ childId: "sa_new", grantId: "sg_new", role: "advisor", status: "queued" }] });
	(manager as any).resolveModel = async () => ({ provider: "test", id: "model" });
	const ctx = {} as any;
	assert.equal((await manager.consultAdvisor("Replace active advisor", ctx)).confirmationRequired, true);
	assert.equal((await manager.consultAdvisor("Replace active advisor", ctx)).confirmationRequired, false);
	assert.deepEqual(reasons, ["replaced_by_new_advisor"]);
});

test("subagent prompt resources carry the approved contract without meta leakage", () => {
	const prompts = [
		...Object.values(SUBAGENT_ROLE_PROMPTS),
		ADVISOR_BRIEF_PROMPT,
		ADVISOR_PROMPT,
		ADVISOR_REPLACEMENT_CONFIRMATION_PROMPT,
		PARENT_ADVISOR_REQUIRED_PROMPT,
		PARENT_REVIEWER_REQUIRED_PROMPT,
		REVIEWER_DEFAULT_PROMPT,
		REVIEWER_ENVELOPE_PROMPT,
		REVIEWER_REPLACEMENT_CONFIRMATION_PROMPT,
	];
	// Packaging and tuning notes must never reach a model.
	const metaLeak = /<!--|pre-release|intentionally modular/iu;
	for (const prompt of prompts) assert.doesNotMatch(prompt, metaLeak);
	// Every child runs detached: it must know nobody answers questions.
	const noQuestions = /cannot ask (?:anyone )?questions|nobody will (?:reply|answer)/iu;
	for (const child of [SUBAGENT_ROLE_PROMPTS.explore, SUBAGENT_ROLE_PROMPTS.work, ADVISOR_PROMPT, REVIEWER_ENVELOPE_PROMPT]) {
		assert.match(child, noQuestions);
	}
	// Approved output skeletons and severity contract.
	assert.match(ADVISOR_PROMPT, /## Recommendation/u);
	assert.match(ADVISOR_PROMPT, /## Next steps/u);
	assert.match(REVIEWER_DEFAULT_PROMPT, /- P0: /u);
	assert.match(REVIEWER_DEFAULT_PROMPT, /- P3: /u);
	assert.match(REVIEWER_DEFAULT_PROMPT, /## Verdict/u);
	assert.match(REVIEWER_DEFAULT_PROMPT, /"No findings\."/u);
	assert.match(PARENT_REVIEWER_REQUIRED_PROMPT, /fix P0 and P1 findings/u);
	assert.match(ADVISOR_BRIEF_PROMPT, /"truncation"/u);
	assert.match(SUBAGENT_ROLE_PROMPTS.work, /Do not commit/u);
});

test("advisor and reviewer mandatory prompts are independent and absent by default", () => {
	let activeTools = [SUBAGENT_START_TOOL, CONSULT_ADVISOR_TOOL, ASK_FOR_REVIEW_TOOL];
	const manager = new SubagentManager({
		getActiveTools: () => activeTools,
		sendMessage() {},
	} as unknown as ExtensionAPI);
	assert.deepEqual(manager.parentPromptSections(), []);
	manager.setRequirements(true, false);
	assert.equal(manager.parentPromptSections().length, 1);
	assert.match(manager.parentPromptSections()[0]!, /advisor consultation/i);
	assert.doesNotMatch(manager.parentPromptSections()[0]!, /Mandatory final review/);
	manager.setRequirements(false, true);
	assert.equal(manager.parentPromptSections().length, 1);
	assert.match(manager.parentPromptSections()[0]!, /Mandatory final review/);
	manager.setRequirements(true, true);
	assert.equal(manager.parentPromptSections().length, 2);
	activeTools = [SUBAGENT_START_TOOL];
	assert.deepEqual(manager.parentPromptSections(), [], "usage guidance follows the dedicated consultation tools");
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
		getActiveTools: () => [SUBAGENT_START_TOOL, CONSULT_ADVISOR_TOOL, ASK_FOR_REVIEW_TOOL],
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
	assert.match(advisorPrompt.systemPrompt, /advisor consultation/i);
	assert.doesNotMatch(advisorPrompt.systemPrompt, /Mandatory final review/);
	await commands.get("reviewer").handler("on", ctx);
	const both = await handlers.get("before_agent_start")?.[0]({ systemPrompt: "base" }, ctx);
	assert.match(both.systemPrompt, /advisor consultation/i);
	assert.match(both.systemPrompt, /Mandatory final review/);
	await commands.get("advisor").handler("off", ctx);
	const reviewerOnly = await handlers.get("before_agent_start")?.[0]({ systemPrompt: "base" }, ctx);
	assert.doesNotMatch(reviewerOnly.systemPrompt, /advisor consultation/i);
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
	await assert.rejects(manager.askForReview("Review", {
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
