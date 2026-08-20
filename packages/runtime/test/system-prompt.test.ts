import { describe, expect, test } from "vitest";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";

describe("buildSystemPrompt", () => {
	describe("empty tools", () => {
		test("shows (none) for empty tools list", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Available tools:\n(none)");
		});

		test("shows file paths guideline even with no tools", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Show file paths clearly");
		});
	});

	describe("default tools", () => {
		test("includes all default tools when snippets are provided", () => {
			const prompt = buildSystemPrompt({
				toolSnippets: {
					read: "Read file contents",
					bash: "Execute bash commands",
					edit: "Make surgical edits",
					write: "Create or overwrite files",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- read:");
			expect(prompt).toContain("- bash:");
			expect(prompt).toContain("- edit:");
			expect(prompt).toContain("- write:");
		});

		test("instructs models to resolve bundled docs and examples under absolute base paths", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(
				"- Resolve docs/... under Additional docs and examples/... under Examples; use those paths as the documentation roots",
			);
			expect(prompt).toContain("environment variables (docs/environment-variables.md)");
		});
	});

	describe("security baseline", () => {
		test("keeps likely secrets out of model-visible commands and output", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("# Security");
			expect(prompt).toContain("passwords, API keys or access tokens");
			expect(prompt).toContain("report only presence and non-sensitive metadata");
			expect(prompt).toContain("trusted non-echoing prompt or credential manager");
			expect(prompt).toContain("Never try to evade an active safety or tool boundary through `cd`");
		});

		test("does not retain a hidden lean assembly branch", () => {
			const legacyOptions = {
				preset: "lean",
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			};
			const prompt = buildSystemPrompt(legacyOptions);

			expect(prompt).toContain("# Working effectively");
			expect(prompt).toContain("# Security");
			expect(prompt).toContain("# Formatting and communication");
		});

		test("preserves explicit custom system-prompt replacement semantics", () => {
			const prompt = buildSystemPrompt({
				customPrompt: "Custom operator prompt",
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Custom operator prompt");
			expect(prompt).not.toContain("# Security");
		});
	});

	describe("evidence baseline", () => {
		test("separates observed facts from assumptions and requires source inspection", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("# Evidence and uncertainty");
			expect(prompt).toContain("Do not guess factual claims, URLs, citations");
			expect(prompt).toContain("Search results and snippets are leads, not evidence");
			expect(prompt).toContain("Prefer primary sources for technical claims");
			expect(prompt).toContain("never presented as verified facts");
		});
	});

	describe("intermediate commentary", () => {
		test("describes commentary as concise user-visible collaboration", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["commentary"],
				toolSnippets: { commentary: "Share a brief user-visible update" },
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("# Intermediate commentary");
			expect(prompt).toContain("use the `commentary` tool");
			expect(prompt).not.toContain("deep_thinking");
			expect(prompt).not.toContain("chain-of-thought");
		});

		test("omits commentary instructions when the tool is unavailable", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("# Intermediate commentary");
		});
	});

	describe("custom tool snippets", () => {
		test("includes custom tools in available tools section when promptSnippet is provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				toolSnippets: {
					dynamic_tool: "Run dynamic test behavior",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- dynamic_tool: Run dynamic test behavior");
		});

		test("omits custom tools from available tools section when promptSnippet is not provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("dynamic_tool");
		});
	});

	describe("prompt guidelines", () => {
		test("appends promptGuidelines to default guidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for project summaries."],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- Use dynamic_tool for project summaries.");
		});

		test("deduplicates and trims promptGuidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for summaries.", "  Use dynamic_tool for summaries.  ", "   "],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt.match(/- Use dynamic_tool for summaries\./g)).toHaveLength(1);
		});
	});
});
