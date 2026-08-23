import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const expectedVersion = "0.82.1";
const expectedSandboxRuntimeVersion = "0.0.67";
const packageRoot = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
const aiPackageRoot = join(root, "node_modules", "@earendil-works", "pi-ai");
const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
if (packageJson.version !== expectedVersion) {
  throw new Error(`Expected patched Pi ${expectedVersion}, found ${packageJson.version}.`);
}
if (packageJson.piConfig?.name !== "mypi" || packageJson.piConfig?.configDir !== ".mypi") {
  throw new Error("Installed Pi runtime is not isolated behind MyPi package/config identity.");
}
if (packageJson.dependencies?.["@anthropic-ai/sandbox-runtime"] !== expectedSandboxRuntimeVersion) {
  throw new Error(
    `Installed Pi runtime does not pin @anthropic-ai/sandbox-runtime ${expectedSandboxRuntimeVersion}.`,
  );
}
if (packageJson.files?.includes("skills")) {
  throw new Error(`Installed Pi ${expectedVersion} still declares bundled skills.`);
}

const requiredReferenceFiles = [
  "README.md",
  join("docs", "extensions.md"),
  join("docs", "sdk.md"),
  join("examples", "README.md"),
  join("examples", "extensions", "README.md"),
  join("examples", "extensions", "hello.ts"),
];
for (const relativePath of requiredReferenceFiles) {
  const content = await readFile(join(packageRoot, relativePath), "utf8");
  if (!content.trim()) {
    throw new Error(`Installed Pi ${expectedVersion} has an empty bundled reference file: ${relativePath}.`);
  }
}

const interactiveMode = await readFile(
  join(packageRoot, "dist", "modes", "interactive", "interactive-mode.js"),
  "utf8",
);
const requiredPatchFragments = [
  "MyPi complete effective-binding hotkey viewer",
  "this.keybindings.getResolvedBindings()",
  "void this.showExtensionCustom",
  "effective MyPi TUI keybinding actions",
  "startupResourceSections",
  "setStartupResourceSections",
  "showExtensionResourceSections",
  "showResourceSections: (sections, title)",
  "pendingClipboardImages",
  "Attached clipboard image",
  "Clipboard paste failed:",
  "streamingBehavior: \"steer\"",
  "streamingBehavior: \"followUp\"",
  "text: result.editorText",
];
for (const fragment of requiredPatchFragments) {
  if (!interactiveMode.includes(fragment)) {
    throw new Error(`Installed Pi ${expectedVersion} is missing the tracked /hotkeys override (${fragment}).`);
  }
}
if (interactiveMode.includes('getCommand("hotkey")') || interactiveMode.includes('text = "/hotkey"')) {
  throw new Error(`Installed Pi ${expectedVersion} still delegates /hotkeys to the deprecated /hotkey extension.`);
}
for (const fragment of ["checkForNewPiVersion", "showNewVersionNotification", "setAvailableVersion"]) {
  if (interactiveMode.includes(fragment)) {
    throw new Error(`Installed Pi ${expectedVersion} still exposes automatic CLI version-update metadata (${fragment}).`);
  }
}
for (const fragment of ["parseModelCommandArguments", "persistGlobal", "global preset updated"]) {
  if (!interactiveMode.includes(fragment)) {
    throw new Error(`Installed Pi ${expectedVersion} is missing session-local /model with explicit --global persistence (${fragment}).`);
  }
}

const productComposition = await readFile(join(packageRoot, "dist", "product", "index.js"), "utf8");
for (const fragment of [
  "productModules",
  "defineProductModule",
  'defineProductModule("goal", "required"',
  'defineProductModule("global-config", "required"',
  'defineProductModule("session-maintenance", "required"',
  'defineProductModule("subagents", "capability"',
  'defineProductModule("cliproxy", "provider"',
  'defineProductModule("gui-control", "surface"',
  "webSearchExtension",
  "planGoalExtension",
  "safetyExtension",
]) {
  if (!productComposition.includes(fragment)) {
    throw new Error(`Installed Pi ${expectedVersion} is missing sealed MyPi product composition (${fragment}).`);
  }
}
const globalConfig = await readFile(join(packageRoot, "dist", "product", "global-config.js"), "utf8");
for (const fragment of ["config.yaml", 'serviceTier: "default"', "shortTestMaxWords: 10", "maxActive: 10", "maxArchived: 10", "maxSessionCheckpoints: 3", "maxDetachedCheckpoints: 1", "warningFiles: 10_000", 'advisorModel: "inherit"', "requireAdvisor: false", "requireReviewer: false", "defaults are active", 'registerCommand("config"']) {
  if (!globalConfig.includes(fragment)) {
    throw new Error(`Installed Pi ${expectedVersion} is missing global YAML configuration behavior (${fragment}).`);
  }
}
if (globalConfig.includes('pi.on("input"')) {
  throw new Error(`Installed Pi ${expectedVersion} allows extension-origin messages to invoke global config mutation.`);
}
const sessionMaintenance = await readFile(join(packageRoot, "dist", "product", "session-maintenance.js"), "utf8");
for (const fragment of ['registerCommand("archive-cleanup"', "previewArchiveCleanup", "runNewSessionMaintenance", "--confirm"]) {
  if (!sessionMaintenance.includes(fragment)) {
    throw new Error(`Installed Pi ${expectedVersion} is missing session maintenance behavior (${fragment}).`);
  }
}
const subagents = await readFile(join(packageRoot, "dist", "product", "subagents.js"), "utf8");
for (const fragment of [
  "subagent_start",
  "consult_advisor",
  "ask_for_review",
  "subagent_followup",
  "advisor_followup",
  "reviewer_followup",
  "subagent_cancel",
  "subagent_status",
  "Route advice to consult_advisor and review to ask_for_review",
  "blocks your edit, write, and Bash",
  "MYPI_SUBAGENT_CHILD",
  "mypi-subagent-results",
  'registerCommand("advisor-model"',
  'registerRequirementCommand(pi, manager, "advisor"',
  'registerRequirementCommand(pi, manager, "reviewer"',
  "advisor_evidence",
  "neutral_brief",
  "arrivedAfterMutation",
]) {
  if (!subagents.includes(fragment)) {
    throw new Error(`Installed Pi ${expectedVersion} is missing async subagent behavior (${fragment}).`);
  }
}
const reviewPolicy = await readFile(join(packageRoot, "dist", "product", "review-policy.js"), "utf8");
for (const fragment of [".mypi", "REVIEW.md", "REVIEW_POLICY_INVALID", "MAX_REVIEW_POLICY_BYTES"]) {
  if (!reviewPolicy.includes(fragment)) throw new Error(`Installed Pi ${expectedVersion} is missing project review policy behavior (${fragment}).`);
}
for (const name of [
  "parent-advisor-required.md",
  "parent-reviewer-required.md",
  "advisor.md",
  "advisor-brief.md",
  "advisor-replacement-confirmation.md",
  "reviewer-envelope.md",
  "reviewer-default.md",
  "reviewer-replacement-confirmation.md",
]) {
  const content = await readFile(join(packageRoot, "dist", "product", "subagent-prompts", name), "utf8");
  if (!content.trim()) throw new Error(`Installed Pi ${expectedVersion} has an empty subagent prompt: ${name}.`);
	if (/\b(?:do not|don't|never|must not|cannot|can't|without|exclude|prohibit|forbid)\b/iu.test(content)) {
		throw new Error(`Installed Pi ${expectedVersion} has a negation directive in subagent prompt: ${name}.`);
	}
}
if (sessionMaintenance.includes('pi.on("input"')) {
  throw new Error(`Installed Pi ${expectedVersion} allows extension-origin messages to invoke archive cleanup.`);
}
const daemonServices = await readFile(join(packageRoot, "dist", "product", "daemon-services.js"), "utf8");
for (const fragment of ["listPersistedSessions", "readPersistedSession", "listDaemonSkills", "listDaemonExtensions", "ProjectTrustStore", "runNewSessionMaintenance", "cleanupArchivedSessions"]) {
  if (!daemonServices.includes(fragment)) {
    throw new Error(`Installed Pi ${expectedVersion} is missing daemon GUI service behavior (${fragment}).`);
  }
}
const workspaceTracker = await readFile(join(packageRoot, "dist", "product", "workspace-tracker.js"), "utf8");
for (const fragment of ["maxSessionCheckpoints", "maxDetachedCheckpoints", "tool-estimate", "previewRewind", "removeAll", '".ssh"']) {
  if (!workspaceTracker.includes(fragment)) throw new Error(`Installed Pi ${expectedVersion} is missing daemon workspace tracking behavior (${fragment}).`);
}
for (const relativePath of [
  join("dist", "product", "goal-prompts", "planning.md"),
  join("dist", "product", "goal-prompts", "continuation.md"),
]) {
  const content = await readFile(join(packageRoot, relativePath), "utf8");
  if (!content.trim()) {
    throw new Error(`Installed Pi ${expectedVersion} has an empty sealed MyPi resource: ${relativePath}.`);
  }
  if (content.includes("Root PLAN.md")) {
    throw new Error(`Installed Pi ${expectedVersion} still gives a project file Goal authority: ${relativePath}.`);
  }
  const requiredFragments = relativePath.endsWith("planning.md")
    ? ["complete dependency-ordered structured plan", "direct evidence needed to verify completion", "Do not implement during planning"]
    : ["External factual claims require an opened source", "After update_goal succeeds", "final response", "Do not stop at the tool call"];
  for (const fragment of requiredFragments) {
    if (!content.includes(fragment)) {
      throw new Error(`Installed Pi ${expectedVersion} is missing the Goal prompt contract (${fragment}): ${relativePath}.`);
    }
  }
}

const planGoal = await readFile(
  join(packageRoot, "dist", "product", "plan-goal.js"),
  "utf8",
);
for (const fragment of ["autoStart", "plan-ready", "Create a branch-local structured Goal v3 plan", "goal-plan-pending", "the tool result is not the final response", "Now give the user a concise final response"]) {
  if (!planGoal.includes(fragment)) {
    throw new Error(`Installed Pi ${expectedVersion} is missing unified Goal planning (${fragment}).`);
  }
}
for (const fragment of ["inspectImportedPlan", "createFilePlanningState", "MAX_IMPORTED_PLAN_BYTES", "FILE_PLAN_TOOLS"]) {
  if (planGoal.includes(fragment)) {
    throw new Error(`Installed Pi ${expectedVersion} still contains retired file planning (${fragment}).`);
  }
}

const goalSafetyProjection = await readFile(join(packageRoot, "dist", "core", "safety-mode.js"), "utf8");
for (const goalTool of ["get_goal", "get_goal_plan", "create_goal", "set_goal_plan", "update_goal_plan", "update_goal"]) {
  if (!goalSafetyProjection.includes(goalTool)) {
    throw new Error(`Installed Pi ${expectedVersion} safety projection can hide Goal tool ${goalTool}.`);
  }
}

const webExtension = await readFile(
  join(packageRoot, "dist", "product", "web", "index.js"),
  "utf8",
);
for (const fragment of [
  'registerCommand("websearch-config"',
  "saveWebSearchPreference",
  "Brave selected, but no Brave credential is configured; curl fallback is effective.",
]) {
  if (!webExtension.includes(fragment)) {
    throw new Error(`Installed Pi ${expectedVersion} is missing built-in web provider selection (${fragment}).`);
  }
}
const webSearch = await readFile(
  join(packageRoot, "dist", "product", "web", "search.js"),
  "utf8",
);
for (const fragment of [
  "resolveWebSearchPreference",
  'requestedProvider === "brave" ? resolveBraveSearchConfig',
  'braveFallback: requestedProvider === "brave"',
]) {
  if (!webSearch.includes(fragment)) {
    throw new Error(`Installed Pi ${expectedVersion} is missing safe web provider fallback (${fragment}).`);
  }
}

const safetyExtension = await readFile(
  join(packageRoot, "dist", "product", "safety.js"),
  "utf8",
);
for (const fragment of [
  'registerCommand("safety"',
  'registerCommand("reasoning"',
  "getAvailableThinkingLevels",
  "/sandbox was replaced by /safety",
]) {
  if (!safetyExtension.includes(fragment)) {
    throw new Error(`Installed Pi ${expectedVersion} is missing built-in safety/reasoning control (${fragment}).`);
  }
}
if (safetyExtension.includes("is pending for the next user turn")) {
  throw new Error(`Installed Pi ${expectedVersion} still emits the retired safety-change notification.`);
}
for (const fragment of [
  'command.name === "shift-tab"',
  'text === "/shift-tab"',
  "handleShiftTabCommand",
  "Shift+Tab now cycles",
]) {
  if (!interactiveMode.includes(fragment)) {
    throw new Error(`Installed Pi ${expectedVersion} is missing local /shift-tab behavior (${fragment}).`);
  }
}
if (interactiveMode.includes("Safety mode pending for next turn")) {
  throw new Error(`Installed Pi ${expectedVersion} still emits the retired Shift+Tab safety toast.`);
}
if (!interactiveMode.includes('prompt.type === "secret"')) {
  throw new Error(`Installed Pi ${expectedVersion} does not route secret authentication prompts through masking.`);
}
const loginDialog = await readFile(
  join(packageRoot, "dist", "modes", "interactive", "components", "login-dialog.js"),
  "utf8",
);
for (const fragment of ["setMasked(secret)", "[secret submitted]"]) {
  if (!loginDialog.includes(fragment)) {
    throw new Error(`Installed Pi ${expectedVersion} is missing non-echoing authentication input (${fragment}).`);
  }
}
const safetyMode = await readFile(join(packageRoot, "dist", "core", "safety-mode.js"), "utf8");
for (const fragment of [
  "SAFETY_MODE_ICONS",
  'safe: "✓"',
  'full: "!"',
  "displayedSafetyMode",
  'name === "ask_user" || name === "set_status"',
  "hasProductAuthority",
]) {
  if (!safetyMode.includes(fragment)) {
    throw new Error(`Installed Pi ${expectedVersion} is missing mode-specific safety footer copy (${fragment}).`);
  }
}
const footer = await readFile(
  join(packageRoot, "dist", "modes", "interactive", "components", "footer.js"),
  "utf8",
);
for (const fragment of ["SAFETY_MODE_FOOTER_COLORS", 'safe: "success"', 'full: "error"']) {
  if (!footer.includes(fragment)) {
    throw new Error(`Installed Pi ${expectedVersion} is missing mode-specific safety footer color (${fragment}).`);
  }
}
const sandboxBash = await readFile(join(packageRoot, "dist", "core", "tools", "bash.js"), "utf8");
if (
  !sandboxBash.includes("createMyPiSandboxProcessLaunch") ||
  !sandboxBash.includes("cleanupMyPiSandboxProcessLaunch") ||
  !sandboxBash.includes("MYPI_SANDBOX_DENIAL_CONTROL") ||
  !sandboxBash.includes("outside-sandbox retry completed with exit code")
) {
  throw new Error(`Installed Pi ${expectedVersion} does not apply sandboxing at the local BashOperations boundary.`);
}
const sandboxPolicy = await readFile(join(packageRoot, "dist", "core", "mypi-sandbox.js"), "utf8");
for (const fragment of [
  "mypi-sandbox-",
  "temporaryDirectory",
  "allowRead",
  "defaultSharedScratchDirectories",
  "Refusing unsafe sandbox scratch cleanup",
]) {
  if (!sandboxPolicy.includes(fragment)) {
    throw new Error(`Installed Pi ${expectedVersion} is missing workspace-confined shell policy (${fragment}).`);
  }
}
const sandboxHelper = await readFile(
  join(packageRoot, "dist", "core", "mypi-sandbox-helper.js"),
  "utf8",
);
for (const fragment of [
  "SandboxRuntimeConfigSchema",
  "wrapWithSandboxArgv",
  "MYPI_SANDBOX_DENIAL_CONTROL",
  "writeSync(3",
  "MyPi sandbox failed closed",
]) {
  if (!sandboxHelper.includes(fragment)) {
    throw new Error(`Installed Pi ${expectedVersion} is missing the isolated sandbox helper (${fragment}).`);
  }
}

const extensionTypes = await readFile(join(packageRoot, "dist", "core", "extensions", "types.d.ts"), "utf8");
for (const fragment of [
  "setStartupResourceSections?",
  "showResourceSections?",
  "Navigate the active session tree",
  "text?: string",
  "AgentSettledOutcome",
  "outcome: AgentSettledOutcome",
  "getSafetyState()",
  "requestSafetyMode(mode:",
]) {
  if (!extensionTypes.includes(fragment)) {
    throw new Error(`Installed Pi ${expectedVersion} is missing the tracked resource UI declaration (${fragment}).`);
  }
}

const extensionRunner = await readFile(join(packageRoot, "dist", "core", "extensions", "runner.js"), "utf8");
if (!extensionRunner.includes("navigateTree: (targetId, options)") || !extensionRunner.includes("return runner.navigateTreeHandler(targetId, options)")) {
  throw new Error(`Installed Pi ${expectedVersion} is missing acknowledged event-context tree navigation.`);
}

const agentSessionTypes = await readFile(join(packageRoot, "dist", "core", "agent-session.d.ts"), "utf8");
for (const fragment of ["requireStreaming?: boolean", "mypiQueuedMessageId?: string", "QueuedMessageItem", "removeQueuedMessage", "updateQueuedMessage"]) {
  if (!agentSessionTypes.includes(fragment)) {
    throw new Error(`Installed Pi ${expectedVersion} is missing the MyPi queue-only prompt declaration (${fragment}).`);
  }
}

const agentSession = await readFile(join(packageRoot, "dist", "core", "agent-session.js"), "utf8");
for (const fragment of [
  "_skillInvocationPresentation",
  "mypiSkillInvocation: skillPresentation",
  "originalText: args || text",
  "options?.source === \"extension\" ? this._skillInvocationPresentation(text)",
  "options?.requireStreaming && !this.isStreaming",
  "Session finished streaming before the queued message could be accepted",
  "mypiQueuedMessageId: queueId",
  "steeringItems",
  "removeQueuedMessage(id)",
  "updateQueuedMessage(id, message)",
  'mypiQueuedMessageMode: "steer"',
  'mypiQueuedMessageMode: "followUp"',
  "mypiShouldContinueAfterThresholdCompaction",
  "collectRetainedRawUserMessages",
  "_mypiProactiveContinuationBudget = 1",
  "mypi-proactive-compaction-continuation",
  "display: false",
  "Existing queues win over proactive continuation",
  "_mypiSettledOutcome",
  "_mypiSettlementEpoch",
  "_mypiEmitDispatchFailureIfUnsettled",
  "await this._mypiEmitDispatchFailureIfUnsettled(settlementEpoch, err)",
  "kind: \"compaction-error\"",
  "outcome: this._mypiSettledOutcome",
  "goalState?.schemaVersion === 3",
  "goalState.workflow === \"goal\"",
  "goalState.status === \"active\"",
  'assistant.stopReason !== "error" && assistant.usage',
]) {
  if (!agentSession.includes(fragment)) {
    throw new Error(`Installed Pi ${expectedVersion} is missing a tracked agent-session customization (${fragment}).`);
  }
}

const compaction = await readFile(join(packageRoot, "dist", "core", "compaction", "compaction.js"), "utf8");
for (const fragment of ["## Active Request", "## User Intent Ledger", "## Governing Constraints", "## Working Set", "## Decisions and Error History", "## Open Loops", "## Handoff", "Immediate next operation", "yield-gate:deterministic-fallback", "RETAINED_RECENT_RAW_USER_MESSAGES", "collectRetainedRawUserMessages"]) {
  if (!compaction.includes(fragment)) {
    throw new Error(`Installed Pi ${expectedVersion} is missing the continuation-safe compaction checkpoint (${fragment}).`);
  }
}
const checkpoint = await readFile(join(packageRoot, "dist", "core", "compaction", "checkpoint.js"), "utf8");
for (const fragment of [
  "This session is being continued from a previous conversation that ran out of context.",
  "Continue the conversation from where it left off without asking the user any further questions.",
  "compaction-backups",
  "Compaction backup integrity check failed",
  "recall_compacted_history",
  "RETAINED_RECENT_RAW_USER_MESSAGES = 3",
  "isRetainedRawUserMessages",
]) {
  if (!checkpoint.includes(fragment)) {
    throw new Error(`Installed Pi ${expectedVersion} is missing durable compaction checkpoint behavior (${fragment}).`);
  }
}
const sessionManager = await readFile(join(packageRoot, "dist", "core", "session-manager.js"), "utf8");
for (const fragment of ["isRetainedRawUserMessages(entry.retainedUserMessages)", "retainedUserMessages,"]) {
  if (!sessionManager.includes(fragment)) {
    throw new Error(`Installed Pi ${expectedVersion} is missing program-owned raw-user retention (${fragment}).`);
  }
}
const compactionRecall = await readFile(
  join(packageRoot, "dist", "product", "compaction-recall.js"),
  "utf8",
);
for (const fragment of ["recall_compacted_history", "current session branch", "sealed pre-compaction transcript"]) {
  if (!compactionRecall.includes(fragment)) {
    throw new Error(`Installed Pi ${expectedVersion} is missing bounded compaction recall (${fragment}).`);
  }
}
const compactionUtils = await readFile(join(packageRoot, "dist", "core", "compaction", "utils.js"), "utf8");
for (const fragment of ["characters omitted from the middle", "Tool result: ${msg.toolName}#${msg.toolCallId}", "untrusted records"]) {
  if (!compactionUtils.includes(fragment)) {
    throw new Error(`Installed Pi ${expectedVersion} is missing provenance-safe compaction serialization (${fragment}).`);
  }
}

if (!agentSessionTypes.includes("AgentSettledOutcome") || !agentSessionTypes.includes("outcome: AgentSettledOutcome")) {
  throw new Error(`Installed Pi ${expectedVersion} is missing the typed agent settlement declaration.`);
}

const rpcMode = await readFile(join(packageRoot, "dist", "modes", "rpc", "rpc-mode.js"), "utf8");
const rpcTypes = await readFile(join(packageRoot, "dist", "modes", "rpc", "rpc-types.d.ts"), "utf8");
for (const fragment of ["mypiAskUser", 'method: "dismiss"', "targetId: id", 'case "navigate_tree"', "getExternallyCurrentModels", "reloadPersistedModelState"]) {
	if (!rpcMode.includes(fragment)) {
		throw new Error(`Installed Pi ${expectedVersion} is missing trusted ask_user RPC cleanup (${fragment}).`);
	}
}

const structuredOutput = await readFile(join(packageRoot, "dist", "core", "structured-output.js"), "utf8");
for (const fragment of [
  'STRUCTURED_OUTPUT_SESSION_ENTRY = "mypi-structured-output"',
  'STRUCTURED_OUTPUT_TOOL_NAME = "mypi_structured_result"',
  '"validation_exhausted"',
  "schemaHash",
  "maxValidationRetries",
  "modelSupportsNativeStructuredOutput",
]) {
  if (!structuredOutput.includes(fragment)) {
    throw new Error(`Installed Pi ${expectedVersion} is missing authoritative structured output (${fragment}).`);
  }
}
for (const fragment of ["structured_result", "structured_result_error", "promptStructured", "schema_conflict"]) {
  if (!agentSession.includes(fragment)) {
    throw new Error(`Installed Pi ${expectedVersion} is missing structured settlement behavior (${fragment}).`);
  }
}
for (const fragment of ["structuredOutput", "StructuredOutputRequest"]) {
  if (!rpcTypes.includes(fragment)) {
    throw new Error(`Installed Pi ${expectedVersion} is missing the structured RPC declaration (${fragment}).`);
  }
}

const aiStructuredProviders = await Promise.all([
  readFile(join(aiPackageRoot, "dist", "api", "anthropic-messages.js"), "utf8"),
  readFile(join(aiPackageRoot, "dist", "api", "openai-responses.js"), "utf8"),
  readFile(join(aiPackageRoot, "dist", "api", "openai-completions.js"), "utf8"),
]);
for (const fragment of ["output_config", "params.text", "response_format"]) {
  if (!aiStructuredProviders.some((provider) => provider.includes(fragment))) {
    throw new Error(`Installed Pi ${expectedVersion} is missing a native structured provider adapter (${fragment}).`);
  }
}
const modelRuntime = await readFile(join(packageRoot, "dist", "core", "model-runtime.js"), "utf8");
for (const fragment of ["reloadPersistedModelState", "allowNetwork: false"]) {
	if (!modelRuntime.includes(fragment)) {
		throw new Error(`Installed Pi ${expectedVersion} is missing external provider-state reload (${fragment}).`);
	}
}
for (const fragment of [
  'method: "mypiAskUser"',
  'method: "dismiss"',
  "targetId: string",
  'type: "navigate_tree"',
  'command: "navigate_tree"',
]) {
  if (!rpcTypes.includes(fragment)) {
    throw new Error(`Installed Pi ${expectedVersion} is missing the trusted ask_user RPC declaration (${fragment}).`);
  }
}

const readTool = await readFile(join(packageRoot, "dist", "core", "tools", "read.js"), "utf8");
if (!readTool.includes("[read skill]") || readTool.includes("[skill]")) {
  throw new Error(`Installed Pi ${expectedVersion} does not distinguish a SKILL.md source read from invocation.`);
}

const systemPrompt = await readFile(join(packageRoot, "dist", "core", "system-prompt.js"), "utf8");
for (const fragment of [
  "You are running in MyPi.",
  "Documentation bundled with MyPi",
  "# Security",
  "passwords, API keys or access tokens",
  "trusted non-echoing prompt or credential manager",
  "Never try to evade an active safety or tool boundary",
  "# Evidence and uncertainty",
  "Search results and snippets are leads, not evidence",
  "Prefer primary sources for technical claims",
  "# Intermediate commentary",
  "use the \\`commentary\\` tool",
]) {
  if (!systemPrompt.includes(fragment)) {
    throw new Error(`Installed Pi ${expectedVersion} is missing the tracked MyPi prompt identity (${fragment}).`);
  }
}
if (systemPrompt.includes("operating inside pi, a coding agent harness")) {
  throw new Error(`Installed Pi ${expectedVersion} still injects the stock product identity.`);
}
if (systemPrompt.includes("deep_thinking")) {
  throw new Error(`Installed Pi ${expectedVersion} still advertises the retired deep_thinking tool name.`);
}

const commentaryTool = await readFile(join(packageRoot, "dist", "core", "tools", "commentary.js"), "utf8");
for (const fragment of ["commentary", "✳ update", "brief user-visible update", "never include secrets or hidden reasoning"]) {
  if (!commentaryTool.includes(fragment)) {
    throw new Error(`Installed Pi ${expectedVersion} is missing commentary tool behavior (${fragment}).`);
  }
}

const settingsManager = await readFile(join(packageRoot, "dist", "core", "settings-manager.js"), "utf8");
if (settingsManager.includes("systemPromptPreset")) {
  throw new Error(`Installed Pi ${expectedVersion} still carries the retired lean system-prompt preset switch.`);
}

const minimalSystemPrompt = await readFile(
  join(packageRoot, "docs", "system-prompts", "minimal.md"),
  "utf8",
);
for (const fragment of ["You are MyPi", "# Evidence and uncertainty", "search snippets are leads, not evidence", "# Security", "trusted non-echoing prompt or credential manager"]) {
  if (!minimalSystemPrompt.includes(fragment)) {
    throw new Error(`Installed Pi ${expectedVersion} is missing the packaged minimal system-prompt replacement (${fragment}).`);
  }
}

const skillInvocation = await readFile(
  join(packageRoot, "dist", "modes", "interactive", "components", "skill-invocation-message.js"),
  "utf8",
);
if (!skillInvocation.includes("[skill loaded]") || skillInvocation.includes("[skill]")) {
  throw new Error(`Installed Pi ${expectedVersion} is missing the explicit skill-invocation label.`);
}

const htmlExport = await readFile(join(packageRoot, "dist", "core", "export-html", "template.js"), "utf8");
if (!htmlExport.includes("[skill loaded]") || htmlExport.includes(">[skill] ")) {
  throw new Error(`Installed Pi ${expectedVersion} HTML export is missing the explicit skill-invocation label.`);
}

const credentialRedaction = await readFile(join(aiPackageRoot, "dist", "credential-redaction.js"), "utf8");
for (const fragment of [
  "REDACTED_OPENROUTER_API_KEY",
  "REDACTED_AWS_ACCESS_KEY_ID",
  "REDACTED_AWS_SECRET_ACCESS_KEY",
  "Provider payload exceeds the credential-redaction nesting limit",
]) {
  if (!credentialRedaction.includes(fragment)) {
    throw new Error(`Installed Pi ${expectedVersion} is missing the outbound credential guard (${fragment}).`);
  }
}

const codexResponses = await readFile(
  join(aiPackageRoot, "dist", "api", "openai-codex-responses.js"),
  "utf8",
);
for (const fragment of ["requiresChatGptAccountId === false", "supportsCodexToolCallIds"]) {
  if (!codexResponses.includes(fragment)) {
    throw new Error(`Installed Pi ${expectedVersion} is missing API-key Codex gateway support (${fragment}).`);
  }
}
const imageInput = await readFile(join(aiPackageRoot, "dist", "utils", "image-input.js"), "utf8");
for (const fragment of ["invalid_image_input", "data URL type", "Image bytes do not match", "MAX_IMAGE_COUNT = 20", "A request may contain at most", "Animated GIF"]) {
  if (!imageInput.includes(fragment)) {
    throw new Error(`Installed Pi ${expectedVersion} is missing bounded image-input normalization (${fragment}).`);
  }
}
const codexCatalog = JSON.parse(await readFile(join(aiPackageRoot, "dist", "providers", "data", "openai-codex.json"), "utf8"));
for (const model of Object.values(codexCatalog["openai-codex-responses"] ?? {})) {
  if (JSON.stringify(model.input) !== JSON.stringify(["text"])) {
    throw new Error(`Installed Pi ${expectedVersion} still advertises unqualified ChatGPT Codex image input for ${model.id}.`);
  }
}
for (const relativePath of ["models.js", "compat.js"]) {
  const implementation = await readFile(join(aiPackageRoot, "dist", relativePath), "utf8");
  for (const fragment of ["redactCredentialPayload(context)", "withCredentialRedaction("]) {
    if (!implementation.includes(fragment)) {
      throw new Error(`Installed Pi ${expectedVersion} ${relativePath} is missing the final credential boundary (${fragment}).`);
    }
  }
}

console.log(`Verified Pi ${expectedVersion}, bundled docs/examples without built-in skills, runtime-owned Plan/Goal/archive/web/TUI/safety core with model-aware /reasoning and local /shift-tab selection, mode-specific safety footer presentation without change toasts, workspace-confined tools, canonical commentary updates with legacy-name compatibility, authoritative structured headless output with native and bounded fallback paths, the built-in security and evidence baseline plus packaged minimal prompt replacement, source-opening web guidance, isolated fail-closed Anthropic shell sandboxing, non-echoing authentication input, API-key Codex gateway compatibility, offline cross-process provider-state reload, suppressed automatic version-update metadata, one-line MyPi identity, outbound credential redaction, /hotkeys, resource viewers, acknowledged tree navigation, skill labels, typed agent settlement including preflight dispatch rejection, program-owned first-plus-last-three raw-user compaction continuity, post-completion Goal summaries, and Goal-aware proactive compaction continuation.`);
