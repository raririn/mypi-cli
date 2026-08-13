import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const continuationTemplate = readFileSync(resolve(import.meta.dirname, "goal-prompts", "continuation.md"), "utf8");

export function renderGoalContinuationPrompt(objective: string, execution: string): string {
	return continuationTemplate
		.replaceAll("{{ objective }}", objective.trim())
		.replaceAll("{{ execution }}", execution.trim());
}

export function goalContinuationTemplateForTest(): string {
	return continuationTemplate;
}
