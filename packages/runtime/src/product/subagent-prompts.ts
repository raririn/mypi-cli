import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const promptDirectory = new URL("./subagent-prompts/", import.meta.url);

function loadPrompt(name: string): string {
	const path = fileURLToPath(new URL(name, promptDirectory));
	const value = readFileSync(path, "utf8").trim();
	if (!value) throw new Error(`Packaged subagent prompt is empty: ${name}`);
	return value;
}

export const PARENT_ADVISOR_REQUIRED_PROMPT = loadPrompt("parent-advisor-required.md");
export const PARENT_REVIEWER_REQUIRED_PROMPT = loadPrompt("parent-reviewer-required.md");
export const EXPLORE_ROLE_PROMPT = loadPrompt("explore.md");
export const WORK_ROLE_PROMPT = loadPrompt("work.md");
export const ADVISOR_PROMPT = loadPrompt("advisor.md");
export const ADVISOR_BRIEF_PROMPT = loadPrompt("advisor-brief.md");
export const ADVISOR_REPLACEMENT_CONFIRMATION_PROMPT = loadPrompt("advisor-replacement-confirmation.md");
export const REVIEWER_ENVELOPE_PROMPT = loadPrompt("reviewer-envelope.md");
export const REVIEWER_DEFAULT_PROMPT = loadPrompt("reviewer-default.md");
export const REVIEWER_REPLACEMENT_CONFIRMATION_PROMPT = loadPrompt("reviewer-replacement-confirmation.md");
