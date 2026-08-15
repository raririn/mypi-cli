import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createWorkspaceReadToolDefinition,
	createWorkspaceWriteToolDefinition,
	resolveWorkspacePath,
} from "../src/core/tools/workspace.ts";

function text(result: { content: readonly { type: string; text?: string }[] }): string {
	return result.content.flatMap((item) => (item.type === "text" ? [item.text ?? ""] : [])).join("\n");
}

describe("workspace-confined tools", () => {
	let root: string;
	let outside: string;

	beforeEach(() => {
		const base = join(tmpdir(), `mypi-workspace-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		root = join(base, "workspace");
		outside = join(base, "outside");
		mkdirSync(root, { recursive: true });
		mkdirSync(outside, { recursive: true });
	});

	afterEach(() => {
		rmSync(join(root, ".."), { recursive: true, force: true });
	});

	it("reads and creates files inside the workspace", async () => {
		writeFileSync(join(root, "input.txt"), "inside");
		const read = createWorkspaceReadToolDefinition(root);
		const write = createWorkspaceWriteToolDefinition(root);

		expect(text(await read.execute("read", { path: "input.txt" }))).toContain("inside");
		await write.execute("write", { path: "nested/output.txt", content: "created" });
		expect(readFileSync(join(root, "nested/output.txt"), "utf8")).toBe("created");
	});

	it.each(["/tmp/outside", "C:\\outside.txt", "../outside.txt", "~/secret", "file:///tmp/secret"])(
		"rejects unsafe input %s",
		(input) => {
			expect(() => resolveWorkspacePath(root, input, false)).toThrow(/workspace|absolute|home|file URL/i);
		},
	);

	it("rejects existing and new targets through a symlink escape", async () => {
		writeFileSync(join(outside, "secret.txt"), "secret");
		symlinkSync(outside, join(root, "escape"), "dir");
		const read = createWorkspaceReadToolDefinition(root);
		const write = createWorkspaceWriteToolDefinition(root);

		await expect(read.execute("read", { path: "escape/secret.txt" })).rejects.toThrow(/outside the working directory/i);
		await expect(write.execute("write", { path: "escape/new.txt", content: "no" })).rejects.toThrow(
			/outside the working directory/i,
		);
	});
});
