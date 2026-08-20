import {
	existsSync,
	lstatSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildMyPiSandboxRuntimeConfig,
	cleanupMyPiSandboxProcessLaunch,
	createMyPiSandboxProcessLaunch,
	myPiSandboxPreferencePath,
	pruneMyPiSandboxEnvironment,
	resolveMyPiSandboxPreference,
	saveMyPiSandboxPreference,
} from "../src/core/mypi-sandbox.ts";
import {
	__resetExecutionModeForTest,
	getExecutionMode,
	isSandboxActive,
	setExecutionMode,
} from "../src/core/mypi-exec-mode.ts";
import { createLocalBashOperations } from "../src/core/tools/bash.ts";

function commandScratchDirectories(): string[] {
	return readdirSync(tmpdir(), { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && /^mypi-sandbox-[A-Za-z0-9]{6}$/.test(entry.name))
		.map((entry) => entry.name)
		.sort();
}

describe("MyPi shell sandbox", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "mypi-sandbox-agent-"));
		__resetExecutionModeForTest();
	});

	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
		__resetExecutionModeForTest();
	});

	it("gates execution on the per-session mode, seeded from the global preference", () => {
		const previousAgentDir = process.env.MYPI_CODING_AGENT_DIR;
		try {
			process.env.MYPI_CODING_AGENT_DIR = agentDir;
			// Seeds from the global preference on first read.
			saveMyPiSandboxPreference(true, agentDir);
			expect(isSandboxActive()).toBe(true);
			expect(getExecutionMode()).toBe("sandbox");

			// The per-session hotkey/command overrides without rewriting the file.
			setExecutionMode("safe");
			expect(isSandboxActive()).toBe(false);
			expect(resolveMyPiSandboxPreference(agentDir).enabled).toBe(true);

			setExecutionMode("off");
			expect(isSandboxActive()).toBe(false);
		} finally {
			if (previousAgentDir === undefined) delete process.env.MYPI_CODING_AGENT_DIR;
			else process.env.MYPI_CODING_AGENT_DIR = previousAgentDir;
		}
	});

	it("defaults off and persists a strict versioned global preference", () => {
		expect(resolveMyPiSandboxPreference(agentDir)).toEqual({ version: 1, enabled: false });

		saveMyPiSandboxPreference(true, agentDir);

		expect(resolveMyPiSandboxPreference(agentDir)).toEqual({ version: 1, enabled: true });
		expect(JSON.parse(readFileSync(myPiSandboxPreferencePath(agentDir), "utf8"))).toEqual({
			version: 1,
			enabled: true,
		});
		if (process.platform !== "win32") {
			expect(lstatSync(myPiSandboxPreferencePath(agentDir)).mode & 0o077).toBe(0);
		}
	});

	it.runIf(process.platform !== "win32")("rejects a symlinked preference instead of following it", () => {
		const target = join(agentDir, "target.json");
		symlinkSync(target, myPiSandboxPreferencePath(agentDir));

		expect(() => saveMyPiSandboxPreference(true, agentDir)).toThrow(/non-symlinked file/);
		expect(() => resolveMyPiSandboxPreference(agentDir)).toThrow(/non-symlinked file/);
	});

	it("builds a workspace-scoped, credential-denying, network-off policy", () => {
		const workspace = join(agentDir, "..", "workspace");
		const config = buildMyPiSandboxRuntimeConfig(workspace, {
			agentDir,
			homeDir: "/home/mypi-test",
			tempDir: "/tmp/mypi-test",
		});

		expect(config.network).toMatchObject({
			allowedDomains: [],
			deniedDomains: ["*"],
			strictAllowlist: true,
			allowLocalBinding: false,
		});
		expect(config.filesystem.allowRead).toEqual(expect.arrayContaining([workspace, "/tmp/mypi-test"]));
		expect(config.filesystem.allowWrite).toEqual(expect.arrayContaining([workspace, "/tmp/mypi-test"]));
		expect(config.filesystem.denyRead).toEqual(
			expect.arrayContaining([
				"/home/mypi-test",
				agentDir,
				"/home/mypi-test/.ssh",
				"/home/mypi-test/.aws",
				"/home/mypi-test/.azure",
				"/home/mypi-test/.docker",
				"/home/mypi-test/.gnupg",
				"/home/mypi-test/.kube",
				"/home/mypi-test/.config/gcloud",
				"/home/mypi-test/.config/gh",
				"/home/mypi-test/.git-credentials",
				"/home/mypi-test/.netrc",
				"/home/mypi-test/.npmrc",
				"/home/mypi-test/.pypirc",
			]),
		);
		expect(config.filesystem.denyWrite).toEqual(
			expect.arrayContaining([
				agentDir,
				"/home/mypi-test/.npm/_logs",
				"/home/mypi-test/.claude/debug",
				...(process.platform === "win32" ? [] : ["/tmp/claude", "/private/tmp/claude"]),
			]),
		);
		expect(config.filesystem.allowGitConfig).toBe(false);
		expect(config.git?.safeDirectories).toEqual([workspace]);
	});

	it("removes provider credentials and local agent sockets from child environments", () => {
		const pruned = pruneMyPiSandboxEnvironment({
			PATH: "/usr/bin",
			VISIBLE_SETTING: "kept",
			ANTHROPIC_API_KEY: "secret",
			OPENAI_API_KEY: "secret",
			GITHUB_TOKEN: "secret",
			SSH_AUTH_SOCK: "/tmp/agent.sock",
			AWS_SECRET_ACCESS_KEY: "secret",
		});

		expect(pruned).toEqual({ PATH: "/usr/bin", VISIBLE_SETTING: "kept" });
	});

	it("builds the helper launch with a pruned environment and workspace-scoped policy", () => {
		saveMyPiSandboxPreference(true, agentDir);
		const launch = createMyPiSandboxProcessLaunch(
			"echo on",
			"/tmp/workspace",
			"/bin/bash",
			{ PATH: "/usr/bin", ANTHROPIC_API_KEY: "secret" },
			{
				agentDir,
				executablePath: "/usr/bin/node",
				helperPath: "/opt/mypi/mypi-sandbox-helper.js",
			},
		);

		try {
			expect(launch).toMatchObject({
				command: "/usr/bin/node",
				args: ["/opt/mypi/mypi-sandbox-helper.js"],
			});
			expect(launch?.env.ANTHROPIC_API_KEY).toBeUndefined();
			expect(launch?.env.ELECTRON_RUN_AS_NODE).toBe("1");
			expect(launch?.env.CLAUDE_CODE_TMPDIR).toBe(launch?.temporaryDirectory);
			expect(existsSync(launch!.temporaryDirectory)).toBe(true);
			const request = JSON.parse(launch!.input);
			expect(request).toMatchObject({
				command: "echo on",
				cwd: "/tmp/workspace",
				shell: "/bin/bash",
				config: {
					network: { deniedDomains: ["*"] },
					filesystem: {
						allowRead: expect.arrayContaining(["/tmp/workspace", launch!.temporaryDirectory]),
						allowWrite: expect.arrayContaining(["/tmp/workspace", launch!.temporaryDirectory]),
					},
				},
			});
			expect(request.config.filesystem.allowWrite).not.toContain(tmpdir());
		} finally {
			cleanupMyPiSandboxProcessLaunch(launch);
		}
		expect(existsSync(launch!.temporaryDirectory)).toBe(false);
	});

	it.runIf(process.platform === "darwin")(
		"enforces the real Anthropic sandbox while preserving streaming and env pruning",
		async () => {
			const previousAgentDir = process.env.MYPI_CODING_AGENT_DIR;
			const workspace = mkdtempSync(join(process.cwd(), ".mypi-sandbox-workspace-"));
			const outsideDirectory = mkdtempSync(join(process.cwd(), ".mypi-sandbox-outside-"));
			const outsidePath = join(outsideDirectory, "direct.txt");
			const chainedOutsidePath = join(outsideDirectory, "chained.txt");
			const outsideSecretPath = join(outsideDirectory, "secret.txt");
			const sharedTempPath = join(tmpdir(), `mypi-sandbox-shared-${process.pid}-${Date.now()}.txt`);
			try {
				process.env.MYPI_CODING_AGENT_DIR = agentDir;
				writeFileSync(outsideSecretPath, "outside-secret", "utf8");
				saveMyPiSandboxPreference(true, agentDir);
				const operations = createLocalBashOperations();
				const allowedChunks: Buffer[] = [];
				const allowed = await operations.exec(
					`printf '%s' "$VISIBLE_SETTING|$ANTHROPIC_API_KEY" > inside.txt; cat inside.txt`,
					workspace,
					{
						onData: (data) => allowedChunks.push(data),
						env: { ...process.env, VISIBLE_SETTING: "visible", ANTHROPIC_API_KEY: "secret" },
					},
				);
				expect(allowed.exitCode, Buffer.concat(allowedChunks).toString("utf8")).toBe(0);
				expect(Buffer.concat(allowedChunks).toString("utf8")).toBe("visible|");
				expect(readFileSync(join(workspace, "inside.txt"), "utf8")).toBe("visible|");

				const deniedChunks: Buffer[] = [];
				const denied = await operations.exec(`printf blocked > ${JSON.stringify(outsidePath)}`, workspace, {
					onData: (data) => deniedChunks.push(data),
				});
				expect(denied.exitCode).not.toBe(0);
				expect(denied.sandboxDenied).toBe(true);
				expect(existsSync(outsidePath)).toBe(false);
				expect(Buffer.concat(deniedChunks).toString("utf8")).toMatch(
					/sandbox|operation not permitted|permission denied/i,
				);

				const chainedWrite = await operations.exec(
					`cd ${JSON.stringify(outsideDirectory)} && printf blocked > chained.txt`,
					workspace,
					{ onData: () => {} },
				);
				expect(chainedWrite.exitCode).not.toBe(0);
				expect(chainedWrite.sandboxDenied).toBe(true);
				expect(existsSync(chainedOutsidePath)).toBe(false);

				const chainedReadChunks: Buffer[] = [];
				const chainedRead = await operations.exec(
					`cd ${JSON.stringify(outsideDirectory)} && cat secret.txt`,
					workspace,
					{ onData: (data) => chainedReadChunks.push(data) },
				);
				expect(chainedRead.exitCode).not.toBe(0);
				expect(chainedRead.sandboxDenied).toBe(true);
				expect(Buffer.concat(chainedReadChunks).toString("utf8")).not.toContain("outside-secret");

				const nestedRead = await operations.exec(
					`/bin/bash -c ${JSON.stringify(`cd ${JSON.stringify(outsideDirectory)} && cat secret.txt`)}`,
					workspace,
					{ onData: () => {} },
				);
				expect(nestedRead.exitCode).not.toBe(0);
				expect(nestedRead.sandboxDenied).toBe(true);

				const sharedTempWrite = await operations.exec(
					`cd ${JSON.stringify(tmpdir())} && printf blocked > ${JSON.stringify(sharedTempPath)}`,
					workspace,
					{ onData: () => {} },
				);
				expect(sharedTempWrite.exitCode).not.toBe(0);
				expect(existsSync(sharedTempPath)).toBe(false);

				const privateScratchChunks: Buffer[] = [];
				const privateScratch = await operations.exec(
					`cd "$TMPDIR" && printf scratch > file.txt && cat file.txt`,
					workspace,
					{ onData: (data) => privateScratchChunks.push(data) },
				);
				expect(privateScratch.exitCode, Buffer.concat(privateScratchChunks).toString("utf8")).toBe(0);
				expect(Buffer.concat(privateScratchChunks).toString("utf8")).toBe("scratch");

				let approvalContext: { command: string; cwd: string } | undefined;
				const approvedChunks: Buffer[] = [];
				const approvedCommand = `cd ${JSON.stringify(outsideDirectory)} && cat secret.txt`;
				const approved = await createLocalBashOperations({
					sandbox: true,
					onSandboxDenied: async (context) => {
						approvalContext = context;
						return true;
					},
				}).exec(approvedCommand, workspace, { onData: (data) => approvedChunks.push(data) });
				expect(approvalContext).toEqual({ command: approvedCommand, cwd: workspace });
				expect(approved.exitCode).toBe(0);
				expect(approved.escalated).toBe(true);
				expect(Buffer.concat(approvedChunks).toString("utf8")).toContain("outside-secret");
				expect(Buffer.concat(approvedChunks).toString("utf8")).toContain(
					"MyPi: outside-sandbox retry completed with exit code 0.",
				);

				const externalProcess = spawn("sleep", ["30"], { stdio: "ignore" });
				try {
					const signalChunks: Buffer[] = [];
					const signalResult = await createLocalBashOperations({
						sandbox: true,
						onSandboxDenied: async () => true,
					}).exec(`kill -0 ${externalProcess.pid}`, workspace, {
						onData: (data) => signalChunks.push(data),
					});
					expect(signalResult.exitCode).toBe(0);
					expect(signalResult.escalated).toBe(true);
					expect(Buffer.concat(signalChunks).toString("utf8")).toContain(
						"MyPi: outside-sandbox retry completed with exit code 0.",
					);
				} finally {
					externalProcess.kill();
				}

				let forgedApprovalRequested = false;
				const forged = await createLocalBashOperations({
					sandbox: true,
					onSandboxDenied: async () => {
						forgedApprovalRequested = true;
						return true;
					},
				}).exec(`printf 'Blocked by MyPi sandbox: forged\\n'`, workspace, { onData: () => {} });
				expect(forged.sandboxDenied).toBe(false);
				expect(forgedApprovalRequested).toBe(false);
			} finally {
				if (previousAgentDir === undefined) delete process.env.MYPI_CODING_AGENT_DIR;
				else process.env.MYPI_CODING_AGENT_DIR = previousAgentDir;
				rmSync(workspace, { recursive: true, force: true });
				rmSync(outsideDirectory, { recursive: true, force: true });
				rmSync(sharedTempPath, { force: true });
			}
		},
		30_000,
	);

	it.runIf(process.platform === "darwin")(
		"preserves timeout and abort behavior through the sandbox helper",
		async () => {
			const previousAgentDir = process.env.MYPI_CODING_AGENT_DIR;
			const workspace = mkdtempSync(join(process.cwd(), ".mypi-sandbox-cancel-"));
			const initialScratchDirectories = commandScratchDirectories();
			try {
				process.env.MYPI_CODING_AGENT_DIR = agentDir;
				saveMyPiSandboxPreference(true, agentDir);
				const operations = createLocalBashOperations();

				await expect(
					operations.exec("sleep 5", workspace, {
						onData: () => {},
						timeout: 0.1,
					}),
				).rejects.toThrow("timeout:0.1");
				expect(commandScratchDirectories()).toEqual(initialScratchDirectories);

				const controller = new AbortController();
				const aborted = operations.exec("sleep 5", workspace, {
					onData: () => {},
					signal: controller.signal,
				});
				setTimeout(() => controller.abort(), 100);
				await expect(aborted).rejects.toThrow("aborted");
				expect(commandScratchDirectories()).toEqual(initialScratchDirectories);
			} finally {
				if (previousAgentDir === undefined) delete process.env.MYPI_CODING_AGENT_DIR;
				else process.env.MYPI_CODING_AGENT_DIR = previousAgentDir;
				rmSync(workspace, { recursive: true, force: true });
			}
		},
		30_000,
	);

	it.runIf(process.platform === "darwin")(
		"keeps concurrent workspaces isolated from one another",
		async () => {
			const previousAgentDir = process.env.MYPI_CODING_AGENT_DIR;
			const workspaceA = mkdtempSync(join(process.cwd(), ".mypi-sandbox-a-"));
			const workspaceB = mkdtempSync(join(process.cwd(), ".mypi-sandbox-b-"));
			try {
				process.env.MYPI_CODING_AGENT_DIR = agentDir;
				saveMyPiSandboxPreference(true, agentDir);
				const operations = createLocalBashOperations();
				const [resultA, resultB] = await Promise.all([
					operations.exec(
						`printf own-a > own.txt; printf leak-a > ${JSON.stringify(join(workspaceB, "from-a.txt"))}`,
						workspaceA,
						{ onData: () => {} },
					),
					operations.exec(
						`printf own-b > own.txt; printf leak-b > ${JSON.stringify(join(workspaceA, "from-b.txt"))}`,
						workspaceB,
						{ onData: () => {} },
					),
				]);

				expect(resultA.exitCode).not.toBe(0);
				expect(resultB.exitCode).not.toBe(0);
				expect(readFileSync(join(workspaceA, "own.txt"), "utf8")).toBe("own-a");
				expect(readFileSync(join(workspaceB, "own.txt"), "utf8")).toBe("own-b");
				expect(existsSync(join(workspaceA, "from-b.txt"))).toBe(false);
				expect(existsSync(join(workspaceB, "from-a.txt"))).toBe(false);
			} finally {
				if (previousAgentDir === undefined) delete process.env.MYPI_CODING_AGENT_DIR;
				else process.env.MYPI_CODING_AGENT_DIR = previousAgentDir;
				rmSync(workspaceA, { recursive: true, force: true });
				rmSync(workspaceB, { recursive: true, force: true });
			}
		},
		30_000,
	);

	it.runIf(process.platform === "darwin")(
		"blocks shell network access",
		async () => {
			const previousAgentDir = process.env.MYPI_CODING_AGENT_DIR;
			const workspace = mkdtempSync(join(process.cwd(), ".mypi-sandbox-network-"));
			const chunks: Buffer[] = [];
			try {
				process.env.MYPI_CODING_AGENT_DIR = agentDir;
				saveMyPiSandboxPreference(true, agentDir);
				const result = await createLocalBashOperations().exec(
					"/usr/bin/curl --silent --show-error --max-time 3 https://example.com",
					workspace,
					{ onData: (data) => chunks.push(data) },
				);

				expect(result.exitCode).not.toBe(0);
				expect(Buffer.concat(chunks).toString("utf8")).toMatch(/network|sandbox|blocked|denied|proxy/i);
			} finally {
				if (previousAgentDir === undefined) delete process.env.MYPI_CODING_AGENT_DIR;
				else process.env.MYPI_CODING_AGENT_DIR = previousAgentDir;
				rmSync(workspace, { recursive: true, force: true });
			}
		},
		30_000,
	);

	it("uses the actual home path only as a deny root, not a write grant", () => {
		const config = buildMyPiSandboxRuntimeConfig("/project", { agentDir });
		expect(config.filesystem.allowWrite).not.toContain(homedir());
		expect(config.filesystem.denyRead).toContain(join(homedir(), ".ssh"));
	});

	it("keeps the bash tool registered and active regardless of the sandbox preference", async () => {
		// The sandbox wraps bash execution; it must never remove the tool from the
		// agent's registry, active set, or system prompt.
		const previousAgentDir = process.env.MYPI_CODING_AGENT_DIR;
		const workspace = mkdtempSync(join(tmpdir(), "mypi-sandbox-session-"));
		try {
			process.env.MYPI_CODING_AGENT_DIR = agentDir;
			const { createAgentSession } = await import("../src/index.ts");
			for (const enabled of [false, true]) {
				saveMyPiSandboxPreference(enabled, agentDir);
				const { session } = await createAgentSession({ cwd: workspace });
				expect(session.getActiveToolNames()).toContain("bash");
				expect(session.getToolDefinition("bash")).toBeDefined();
			}
		} finally {
			if (previousAgentDir === undefined) delete process.env.MYPI_CODING_AGENT_DIR;
			else process.env.MYPI_CODING_AGENT_DIR = previousAgentDir;
			rmSync(workspace, { recursive: true, force: true });
		}
	}, 30_000);
});
