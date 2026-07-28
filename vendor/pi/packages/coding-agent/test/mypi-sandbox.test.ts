import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildMyPiSandboxRuntimeConfig,
	createMyPiSandboxProcessLaunch,
	myPiSandboxPreferencePath,
	pruneMyPiSandboxEnvironment,
	resolveMyPiSandboxPreference,
	saveMyPiSandboxPreference,
} from "../src/core/mypi-sandbox.ts";
import { createLocalBashOperations } from "../src/core/tools/bash.ts";

describe("MyPi shell sandbox", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "mypi-sandbox-agent-"));
	});

	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
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
		expect(config.filesystem.allowWrite).toEqual(expect.arrayContaining([workspace, "/tmp/mypi-test"]));
		expect(config.filesystem.denyRead).toEqual(
			expect.arrayContaining([
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
			expect.arrayContaining([agentDir, "/home/mypi-test/.npm/_logs", "/home/mypi-test/.claude/debug"]),
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

	it("selects the helper only when the global preference is enabled", () => {
		expect(
			createMyPiSandboxProcessLaunch("echo off", "/tmp/workspace", "/bin/bash", { PATH: "/usr/bin" }, { agentDir }),
		).toBeUndefined();

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

		expect(launch).toMatchObject({
			command: "/usr/bin/node",
			args: ["/opt/mypi/mypi-sandbox-helper.js"],
		});
		expect(launch?.env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(launch?.env.ELECTRON_RUN_AS_NODE).toBe("1");
		expect(JSON.parse(launch!.input)).toMatchObject({
			command: "echo on",
			cwd: "/tmp/workspace",
			shell: "/bin/bash",
			config: {
				network: { deniedDomains: ["*"] },
				filesystem: { allowWrite: expect.arrayContaining(["/tmp/workspace"]) },
			},
		});
	});

	it.runIf(process.platform === "darwin")(
		"enforces the real Anthropic sandbox while preserving streaming and env pruning",
		async () => {
			const previousAgentDir = process.env.MYPI_CODING_AGENT_DIR;
			const workspace = mkdtempSync(join(process.cwd(), ".mypi-sandbox-workspace-"));
			const outsidePath = join(process.cwd(), `.mypi-sandbox-denied-${process.pid}-${Date.now()}`);
			try {
				process.env.MYPI_CODING_AGENT_DIR = agentDir;
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
				expect(existsSync(outsidePath)).toBe(false);
				expect(Buffer.concat(deniedChunks).toString("utf8")).toMatch(
					/sandbox|operation not permitted|permission denied/i,
				);
			} finally {
				if (previousAgentDir === undefined) delete process.env.MYPI_CODING_AGENT_DIR;
				else process.env.MYPI_CODING_AGENT_DIR = previousAgentDir;
				rmSync(workspace, { recursive: true, force: true });
				rmSync(outsidePath, { force: true });
			}
		},
		30_000,
	);

	it.runIf(process.platform === "darwin")(
		"preserves timeout and abort behavior through the sandbox helper",
		async () => {
			const previousAgentDir = process.env.MYPI_CODING_AGENT_DIR;
			const workspace = mkdtempSync(join(process.cwd(), ".mypi-sandbox-cancel-"));
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

				const controller = new AbortController();
				const aborted = operations.exec("sleep 5", workspace, {
					onData: () => {},
					signal: controller.signal,
				});
				setTimeout(() => controller.abort(), 100);
				await expect(aborted).rejects.toThrow("aborted");
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
});
