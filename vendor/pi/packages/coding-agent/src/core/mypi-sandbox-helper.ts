import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { SandboxManager, SandboxRuntimeConfigSchema } from "@anthropic-ai/sandbox-runtime";
import type { MyPiSandboxHelperRequest } from "./mypi-sandbox.ts";

const MAX_PROTOCOL_BYTES = 4 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const SANDBOX_DENIAL_PATTERN =
	/(?:operation not permitted|permission denied|read-only file system|connection blocked by network allowlist|sandbox(?:ed)?\s+(?:denial|violation|blocked))/i;

function readRequest(): MyPiSandboxHelperRequest {
	const input = readFileSync(0);
	if (input.length === 0 || input.length > MAX_PROTOCOL_BYTES) {
		throw new Error(`invalid helper request size (${input.length} bytes)`);
	}
	let value: unknown;
	try {
		value = JSON.parse(input.toString("utf8"));
	} catch {
		throw new Error("invalid helper request JSON");
	}
	if (!value || typeof value !== "object") {
		throw new Error("invalid helper request");
	}
	const candidate = value as Partial<MyPiSandboxHelperRequest>;
	if (
		typeof candidate.command !== "string" ||
		typeof candidate.cwd !== "string" ||
		typeof candidate.shell !== "string" ||
		!candidate.cwd ||
		!candidate.shell
	) {
		throw new Error("invalid helper command, cwd, or shell");
	}
	return {
		command: candidate.command,
		cwd: candidate.cwd,
		shell: candidate.shell,
		config: SandboxRuntimeConfigSchema.parse(candidate.config),
	};
}

async function run(): Promise<number> {
	const request = readRequest();
	const configuredTempDir = process.env.CLAUDE_CODE_TMPDIR;
	if (configuredTempDir) {
		mkdirSync(configuredTempDir, { recursive: true, mode: 0o700 });
	}
	await SandboxManager.initialize(request.config, undefined, true);
	const wrapped = await SandboxManager.wrapWithSandboxArgv(
		request.command,
		request.shell,
		undefined,
		undefined,
		request.cwd,
	);

	return new Promise<number>((resolve, reject) => {
		const child = spawn(wrapped.argv[0]!, wrapped.argv.slice(1), {
			cwd: request.cwd,
			env: wrapped.env,
			shell: false,
			stdio: ["ignore", "inherit", "pipe"],
			windowsHide: true,
		});
		let stderr = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			process.stderr.write(chunk);
			stderr = `${stderr}${chunk.toString("utf8")}`.slice(-MAX_DIAGNOSTIC_BYTES);
		});
		child.once("error", reject);
		child.once("close", (code, signal) => {
			if (code !== 0) {
				const annotated = SandboxManager.annotateStderrWithSandboxFailures(request.command, stderr);
				if (annotated !== stderr) {
					const annotation = annotated.startsWith(stderr) ? annotated.slice(stderr.length) : annotated;
					if (annotation) process.stderr.write(annotation.startsWith("\n") ? annotation : `\n${annotation}`);
				} else if (SANDBOX_DENIAL_PATTERN.test(stderr)) {
					process.stderr.write(
						"\nBlocked by MyPi sandbox: the command attempted an operation outside the workspace/network policy.\n",
					);
				}
			}
			resolve(code ?? (signal ? 128 : 1));
		});
	});
}

let exitCode = 126;
try {
	exitCode = await run();
} catch (error) {
	process.stderr.write(`MyPi sandbox failed closed: ${error instanceof Error ? error.message : String(error)}\n`);
} finally {
	try {
		SandboxManager.cleanupAfterCommand();
		await SandboxManager.reset();
	} catch (error) {
		process.stderr.write(`MyPi sandbox cleanup warning: ${error instanceof Error ? error.message : String(error)}\n`);
		if (exitCode === 0) exitCode = 126;
	}
}
process.exitCode = exitCode;
