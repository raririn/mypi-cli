import { beforeAll, describe, expect, test, vi } from "vitest";
import { Container } from "@earendil-works/pi-tui";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const prototype = InteractiveMode.prototype as any;

function rendered(container: Container): string {
	return container.children.flatMap((child) => child.render(140)).join("\n").replace(/\u001b\[[0-9;]*m/g, "");
}

describe("InteractiveMode daemon tracking presentation", () => {
	beforeAll(() => initTheme("dark"));

	test("renders estimated counts, opaque paths, and overlap warning", () => {
		const context: any = { chatContainer: new Container(), ui: { requestRender: vi.fn() } };
		prototype.renderTurnChanges.call(context, {
			id: "changes", sessionId: "s", createdAt: new Date().toISOString(), basis: "tool-estimate",
			quality: "estimated", trackerStatus: "disabled", estimated: true,
			intersection: "concurrent-session", affectedTaskCount: 1, omissions: [],
			files: [
				{ fileId: "f1", path: "src/a.ts", status: "modified", additions: 3, deletions: 1, opaque: false, diffAvailable: false, provenance: "tool-estimate" },
				{ fileId: "f2", path: "dist/app.bin", status: "added", opaque: true, diffAvailable: false, provenance: "tool-estimate" },
			],
		});
		const output = rendered(context.chatContainer);
		expect(output).toContain("Estimated · Changed 2 files · +3 −1");
		expect(output).toContain("dist/app.bin  opaque");
		expect(output).toContain("Changes may include work from another task");
	});

	test("rewind requires affected-task confirmation and executes the preview token", async () => {
		const executeRewind = vi.fn(async () => ({ removed: 2, affectedOtherTasks: 1, generation: 2 }));
		const context: any = {
			session: {
				isIdle: true,
				daemonWorkspace: {
					listCheckpoints: vi.fn(async () => ({ status: "ready", checkpoints: [{ id: "c1", promptPreview: "Fix parser", createdAt: "2026-08-22T00:00:00Z" }] })),
					prepareRewind: vi.fn(async () => ({ operationToken: "token", files: [], affectedOtherTasks: 1, laterOwned: 2 })),
					executeRewind,
				},
			},
			showExtensionSelector: vi.fn(async (_title: string, options: string[]) => options[0]),
			showExtensionConfirm: vi.fn(async () => true),
			showStatus: vi.fn(), showWarning: vi.fn(), showError: vi.fn(),
		};
		await prototype.handleRewindCommand.call(context);
		expect(context.showExtensionConfirm).toHaveBeenCalledTimes(2);
		expect(executeRewind).toHaveBeenCalledWith("token", true);
		expect(context.showStatus).toHaveBeenCalledWith("Rewound workspace; removed 2 later checkpoints.");
	});

	test("startup consent saves the selected exact-root tracking decision", async () => {
		const setProjectTracking = vi.fn(async () => {});
		const context: any = {
			session: {
				daemonWorkspace: {
					getProjectTracking: vi.fn(async () => ({
						root: "/workspace", trusted: true, tracking: null, status: "unconfigured",
						estimate: { files: 12, bytes: 1024, truncated: false, broadRoot: false, warning: false },
					})),
					setProjectTracking,
				},
			},
			sessionManager: { getCwd: () => "/workspace" },
			formatTrackingEstimate: prototype.formatTrackingEstimate,
			showExtensionSelector: vi.fn(async () => "Track"),
			showWarning: vi.fn(),
		};
		await prototype.ensureWorkspaceTrackingConsent.call(context);
		expect(setProjectTracking).toHaveBeenCalledWith("/workspace", "track");
	});
});
