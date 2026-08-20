import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";
import { cleanupArchivedSessions, previewArchiveCleanup, runNewSessionMaintenance } from "./daemon-services.ts";

const HELP = `# /archive-cleanup — trim old archived histories for this project

## Syntax

/archive-cleanup
/archive-cleanup --confirm
/archive-cleanup --help

The command keeps the newest history.maxArchived archives for the current
project and permanently deletes only the older excess. Without --confirm, MyPi
shows the exact count and asks for confirmation through the active UI. Active
history is never deleted. Configure the limit with /config history max-archived.`;

export default function sessionMaintenanceExtension(pi: ExtensionAPI): void {
	const handleCleanup = async (args: string, ctx: ExtensionContext) => {
		const option = args.trim();
		if (option === "--help" || option === "help") {
			await ctx.ui.editor("Archive cleanup help", HELP);
			return;
		}
		if (option && option !== "--confirm") {
			ctx.ui.notify("Usage: /archive-cleanup [--confirm|--help]", "warning");
			return;
		}
		if (!ctx.isIdle()) {
			ctx.ui.notify("Wait for the active run to settle before cleaning archived histories.", "warning");
			return;
		}
		const preview = await previewArchiveCleanup(ctx.cwd);
		if (preview.configDiagnostic) ctx.ui.notify(preview.configDiagnostic.message, "warning");
		if (preview.excess === 0) {
			ctx.ui.notify(`No archive cleanup is needed: ${preview.archivedCount}/${preview.maxArchived} retained for this project.`, "info");
			return;
		}
		let confirmed = option === "--confirm";
		if (!confirmed) {
			if (!ctx.hasUI) {
				ctx.ui.notify(`Archive cleanup needs confirmation. Re-run /archive-cleanup --confirm to delete ${preview.excess} old archives.`, "warning");
				return;
			}
			confirmed = await ctx.ui.confirm(
				"Delete old archived histories?",
				`Permanently delete ${preview.excess} older archived histories for this project and keep the newest ${preview.maxArchived}? This cannot be undone.`,
			);
		}
		if (!confirmed) {
			ctx.ui.notify("Archive cleanup cancelled; no history was changed.", "info");
			return;
		}
		const result = await cleanupArchivedSessions(ctx.cwd, { confirm: true });
		ctx.ui.notify(
			`Archive cleanup deleted ${result.deleted.length}/${result.preview.excess} old histories${result.failures.length ? `; ${result.failures.length} were preserved after safety checks failed` : ""}.`,
			result.failures.length ? "warning" : "info",
		);
	};

	pi.registerCommand("archive-cleanup", {
		description: "Permanently trim old archived histories for this project after confirmation",
		getArgumentCompletions: (prefix) => {
			const items = ["--confirm", "--help"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
			return items.length ? items : null;
		},
		handler: handleCleanup,
	});
	pi.on("input", async (event, ctx) => {
		if (event.source !== "extension") return undefined;
		const match = event.text.trim().match(/^\/archive-cleanup(?:\s+([\s\S]*))?$/iu);
		if (!match) return undefined;
		await handleCleanup(match[1] ?? "", ctx);
		return { action: "handled" };
	});

	pi.on("session_start", (event, ctx) => {
		if (event.reason !== "new" || process.env.MYPI_DAEMON_ENGINE === "1") return;
		const sessionFile = ctx.sessionManager.getSessionFile();
		const sessionId = ctx.sessionManager.getSessionId();
		if (!sessionFile || !sessionId) return;
		void runNewSessionMaintenance({ sessionFile, sessionId, cwd: ctx.cwd }).then(
			(result) => {
				const archived = result.archivedShortTests.length + result.archivedOverflow.length;
				if (archived > 0) ctx.ui.notify(`Archived ${archived} inactive histories during new-session maintenance.`, "info");
				if (result.archivedExcess > 0) {
					ctx.ui.notify(
						`${result.archivedCount} archived histories are stored for this project. Run /archive-cleanup to keep the newest ${result.config.maxArchived}.`,
						"warning",
					);
				}
			},
			(error) => ctx.ui.notify(`New-session maintenance could not complete: ${error instanceof Error ? error.message : String(error)}`, "warning"),
		);
	});
}
