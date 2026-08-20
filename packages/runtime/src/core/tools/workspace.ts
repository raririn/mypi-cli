import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { Type } from "typebox";
import { isAbsoluteOnAnyPlatform, isPathInside } from "../safety-mode.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { createReadToolDefinition, type ReadToolDetails, type ReadToolOptions } from "./read.ts";
import { createWriteToolDefinition, type WriteToolOptions } from "./write.ts";

const workspaceReadSchema = Type.Object({
	path: Type.String({ description: "Workspace-relative path to the file to read" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

const workspaceWriteSchema = Type.Object({
	path: Type.String({ description: "Workspace-relative path to the file to create or overwrite" }),
	content: Type.String({ description: "Content to write to the file" }),
});

function assertRelativeInput(path: string): void {
	if (!path || path.includes("\0")) throw new Error("Workspace path must be a non-empty relative path.");
	if (isAbsoluteOnAnyPlatform(path)) throw new Error("Workspace tools do not accept absolute paths.");
	if (path === "~" || path.startsWith("~/") || path.startsWith("~\\")) {
		throw new Error("Workspace tools do not expand home-directory paths.");
	}
	if (/^file:/i.test(path)) throw new Error("Workspace tools do not accept file URLs.");
}

function nearestExistingAncestor(path: string): string {
	let current = path;
	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) return current;
		current = parent;
	}
	return current;
}

export function resolveWorkspacePath(workspace: string, input: string, requireExisting: boolean): string {
	assertRelativeInput(input);
	const root = realpathSync(resolve(workspace));
	const candidate = resolve(root, input);
	if (!isPathInside(candidate, root)) throw new Error(`Workspace path escapes the working directory: ${input}`);

	if (requireExisting && !existsSync(candidate)) throw new Error(`Workspace path does not exist: ${input}`);
	const anchor = existsSync(candidate) ? candidate : nearestExistingAncestor(candidate);
	lstatSync(anchor);
	const canonicalAnchor = realpathSync(anchor);
	if (!isPathInside(canonicalAnchor, root)) {
		throw new Error(`Workspace path resolves outside the working directory: ${input}`);
	}
	return candidate;
}

export function createWorkspaceReadToolDefinition(
	workspace: string,
	options?: ReadToolOptions,
): ToolDefinition<typeof workspaceReadSchema, ReadToolDetails | undefined> {
	const base = createReadToolDefinition(workspace, {
		...options,
		pathGuard: (path) => {
			resolveWorkspacePath(workspace, relative(realpathSync(resolve(workspace)), path), true);
		},
	});
	return {
		...base,
		name: "read_workspace",
		label: "read workspace",
		description:
			"Read a file inside the current workspace. Paths must be relative; absolute paths, traversal, home expansion, file URLs, and symlink escapes are rejected.",
		promptSnippet: "Read files inside the workspace",
		parameters: workspaceReadSchema,
		async execute(toolCallId, input, signal, onUpdate, ctx) {
			const absolutePath = resolveWorkspacePath(workspace, input.path, true);
			return base.execute(toolCallId, { ...input, path: absolutePath }, signal, onUpdate, ctx);
		},
	};
}

export function createWorkspaceWriteToolDefinition(
	workspace: string,
	options?: WriteToolOptions,
): ToolDefinition<typeof workspaceWriteSchema, undefined> {
	const base = createWriteToolDefinition(workspace, {
		...options,
		pathGuard: (path) => {
			resolveWorkspacePath(workspace, relative(realpathSync(resolve(workspace)), path), false);
		},
	});
	return {
		...base,
		name: "write_workspace",
		label: "write workspace",
		description:
			"Create or overwrite a file inside the current workspace. Paths must be relative; absolute paths, traversal, home expansion, file URLs, and symlink escapes are rejected.",
		promptSnippet: "Create or overwrite files inside the workspace",
		parameters: workspaceWriteSchema,
		async execute(toolCallId, input, signal, onUpdate, ctx) {
			const absolutePath = resolveWorkspacePath(workspace, input.path, false);
			return base.execute(toolCallId, { ...input, path: absolutePath }, signal, onUpdate, ctx);
		},
	};
}
