import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ProjectTrustDeclinedError,
	resolveProjectTrusted,
} from "../src/core/project-trust.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";

describe("project trust preflight", () => {
	let root: string;
	let workspace: string;
	let store: ProjectTrustStore;

	beforeEach(() => {
		root = join(tmpdir(), `mypi-project-trust-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		workspace = join(root, "workspace");
		mkdirSync(workspace, { recursive: true });
		store = new ProjectTrustStore(join(root, "agent"));
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	function context(select: () => Promise<string | undefined>) {
		return {
			cwd: workspace,
			mode: "tui" as const,
			hasUI: true,
			ui: {
				select: async () => select(),
				confirm: async () => false,
				input: async () => undefined,
				notify: () => {},
			},
		};
	}

	it("aborts an unknown interactive launch when the user cancels without persisting denial", async () => {
		await expect(
			resolveProjectTrusted({
				cwd: workspace,
				trustStore: store,
				projectTrustContext: context(async () => "Cancel"),
			}),
		).rejects.toBeInstanceOf(ProjectTrustDeclinedError);
		expect(store.get(workspace)).toBeNull();
	});

	it("persists an affirmative host-local decision and skips later prompts", async () => {
		expect(
			await resolveProjectTrusted({
				cwd: workspace,
				trustStore: store,
				projectTrustContext: context(async () => "Trust"),
			}),
		).toBe(true);
		expect(store.get(workspace)).toBe(true);

		expect(
			await resolveProjectTrusted({
				cwd: workspace,
				trustStore: store,
				projectTrustContext: context(async () => {
					throw new Error("saved trust should skip UI");
				}),
			}),
		).toBe(true);
	});

	it("treats a saved denial as an interactive exit and fails closed without a UI", async () => {
		store.set(workspace, false);
		await expect(
			resolveProjectTrusted({
				cwd: workspace,
				trustStore: store,
				projectTrustContext: context(async () => {
					throw new Error("saved denial should skip UI");
				}),
			}),
		).rejects.toBeInstanceOf(ProjectTrustDeclinedError);

		expect(
			await resolveProjectTrusted({
				cwd: workspace,
				trustStore: store,
				projectTrustContext: {
					...context(async () => undefined),
					hasUI: false,
					mode: "print",
				},
			}),
		).toBe(false);
	});

	it("does not let a legacy global default bypass an unknown workspace preflight", async () => {
		let prompted = false;
		await expect(
			resolveProjectTrusted({
				cwd: workspace,
				trustStore: store,
				defaultProjectTrust: "always",
				projectTrustContext: context(async () => {
					prompted = true;
					return "Cancel";
				}),
			}),
		).rejects.toBeInstanceOf(ProjectTrustDeclinedError);
		expect(prompted).toBe(true);
	});
});
