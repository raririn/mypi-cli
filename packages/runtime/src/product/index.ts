import archiveManageExtension from "./archive-manage.ts";
import compactionRecallExtension from "./compaction-recall.ts";
import guiControlExtension from "./gui-control/index.ts";
import globalConfigExtension from "./global-config.ts";
import hooksExtension from "./hooks.ts";
import llamaExtension from "./llama/index.ts";
import agentSignalsExtension from "./mypi-agent-signals.ts";
import askUserExtension from "./mypi-ask-user.ts";
import chatManageExtension from "./mypi-chat-manage.ts";
import chatExtension from "./mypi-chat.ts";
import cliproxyProviderExtension from "./mypi-cliproxy-provider.ts";
import credentialRedactionExtension from "./mypi-credential-redaction.ts";
import exitExtension from "./mypi-exit.ts";
import identityExtension from "./mypi-identity.ts";
import keywordSkillRouterExtension from "./mypi-keyword-skill-router.ts";
import progressBriefsExtension from "./mypi-progress-briefs.ts";
import readonlyExtension from "./mypi-readonly.ts";
import redpandaProviderExtension from "./mypi-redpanda-provider.ts";
import safemodeExtension from "./mypi-safemode.ts";
import tuiAutoTitleExtension from "./mypi-tui-auto-title.ts";
import workingTimerExtension from "./mypi-working-timer.ts";
import planGoalExtension from "./plan-goal.ts";
import { defineProductModule, type ProductModule } from "./registry.ts";
import safetyExtension from "./safety.ts";
import sessionMaintenanceExtension from "./session-maintenance.ts";
import subagentsExtension from "./subagents.ts";
import pizzaHeroExtension from "./tui-hero/index.ts";
import webSearchExtension from "./web/index.ts";

/**
 * Ordered, sealed MyPi composition. The order preserves the former runtime
 * built-in followed by legacy profile-module handler ordering while making authority and
 * activation class explicit. Dynamic extension discovery cannot add entries.
 */
export const productModules: readonly ProductModule[] = [
	defineProductModule("llama.cpp", "provider", llamaExtension),
	defineProductModule("goal", "required", planGoalExtension),
	defineProductModule("global-config", "required", globalConfigExtension),
	defineProductModule("session-maintenance", "required", sessionMaintenanceExtension),
	defineProductModule("subagents", "capability", subagentsExtension),
	defineProductModule("hooks", "capability", hooksExtension),
	defineProductModule("archive", "capability", archiveManageExtension),
	defineProductModule("compaction-recall", "required", compactionRecallExtension),
	defineProductModule("tui-hero", "surface", pizzaHeroExtension),
	defineProductModule("safety", "required", safetyExtension),
	defineProductModule("web", "capability", webSearchExtension),
	defineProductModule("identity", "required", identityExtension),
	defineProductModule("credential-redaction", "required", credentialRedactionExtension),
	defineProductModule("agent-signals", "capability", agentSignalsExtension),
	defineProductModule("ask-user", "capability", askUserExtension),
	defineProductModule("chat-manage", "surface", chatManageExtension),
	defineProductModule("exit", "surface", exitExtension),
	defineProductModule("keyword-skill-router", "capability", keywordSkillRouterExtension),
	defineProductModule("progress-briefs", "capability", progressBriefsExtension),
	defineProductModule("readonly", "required", readonlyExtension),
	defineProductModule("cliproxy", "provider", cliproxyProviderExtension),
	defineProductModule("redpanda", "provider", redpandaProviderExtension),
	defineProductModule("safemode", "compatibility", safemodeExtension),
	defineProductModule("tui-auto-title", "surface", tuiAutoTitleExtension),
	defineProductModule("working-timer", "surface", workingTimerExtension),
	defineProductModule("gui-control", "surface", guiControlExtension),
];

export type ProductProfile = "coding" | "chat" | "none";

const chatProductModules: readonly ProductModule[] = [defineProductModule("chat", "surface", chatExtension)];

export function productModulesForProfile(profile: ProductProfile): readonly ProductModule[] {
	if (profile === "none") return [];
	if (profile === "chat") return chatProductModules;
	return productModules;
}
