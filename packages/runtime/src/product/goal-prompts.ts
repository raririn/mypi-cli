import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const planningTemplate = readFileSync(resolve(import.meta.dirname, "goal-prompts", "planning.md"), "utf8");
const continuationTemplate = readFileSync(resolve(import.meta.dirname, "goal-prompts", "continuation.md"), "utf8");

export function goalPlanningPrompt(): string {
	return planningTemplate;
}

export function renderGoalContinuationPrompt(objective: string, execution: string): string {
	return continuationTemplate
		.replaceAll("{{ objective }}", objective.trim())
		.replaceAll("{{ execution }}", execution.trim());
}

export function goalContinuationTemplateForTest(): string {
	return continuationTemplate;
}

export function goalPlanningTemplateForTest(): string {
	return planningTemplate;
}
