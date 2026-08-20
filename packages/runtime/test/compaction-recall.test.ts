import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { describe, expect, it } from "vitest";
import compactionRecallExtension from "../src/product/compaction-recall.ts";

function createHarness(branch: unknown[] = []) {
	let tool: any;
	compactionRecallExtension({
		registerTool(definition: unknown) {
			tool = definition;
		},
	} as ExtensionAPI);
	return {
		tool,
		ctx: { sessionManager: { getBranch: () => branch } },
	};
}

describe("recall_compacted_history", () => {
	it("registers a checkpoint-ID-only bounded schema with provenance guidance", () => {
		const { tool } = createHarness();

		expect(tool.name).toBe("recall_compacted_history");
		expect(Object.keys(tool.parameters.properties)).toEqual([
			"checkpoint_id",
			"query",
			"around_entry_id",
			"max_chars",
		]);
		expect(tool.parameters.properties.max_chars.maximum).toBe(12_000);
		expect(tool.description).toContain("current branch");
		expect(tool.promptGuidelines.join("\n")).toContain("original user messages");
		expect(JSON.stringify(tool.parameters)).not.toMatch(/(?:file_)?path/i);
	});

	it("fails closed unless the requested checkpoint is on the active branch and sealed", async () => {
		const missing = createHarness();
		await expect(
			missing.tool.execute(
				"call-1",
				{ checkpoint_id: "checkpoint-1" },
				undefined,
				undefined,
				missing.ctx,
			),
		).rejects.toThrow("current session branch");

		const details = {
			checkpointVersion: 2,
			checkpointId: "checkpoint-1",
			source: {
				firstKeptEntryId: "entry-1",
				sourceBranchHeadId: "entry-1",
			},
			retainedUserMessages: [],
			evidence: { userMessages: [], toolResults: [], readFiles: [], modifiedFiles: [] },
			validation: {
				valid: true,
				gaps: [],
				deterministicRepairs: [],
				generationAttempts: 1,
				method: "single-pass",
			},
			readFiles: [],
			modifiedFiles: [],
		};
		const unsealed = createHarness([{ type: "compaction", details }]);
		await expect(
			unsealed.tool.execute(
				"call-2",
				{ checkpoint_id: "checkpoint-1" },
				undefined,
				undefined,
				unsealed.ctx,
			),
		).rejects.toThrow("no sealed persisted-session backup");
	});
});
