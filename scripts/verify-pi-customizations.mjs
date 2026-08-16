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

const builtInExtensions = await readFile(join(packageRoot, "dist", "extensions", "index.js"), "utf8");
for (const fragment of [
  "mypi-core",
  "myPiCoreExtension",
  "webSearchExtension",
  "planGoalExtension",
  "safetyExtension",
]) {
  if (!builtInExtensions.includes(fragment)) {
    throw new Error(`Installed Pi ${expectedVersion} is missing a runtime-owned MyPi core feature (${fragment}).`);
  }
}
for (const relativePath of [
  join("dist", "extensions", "mypi", "goal-prompts", "continuation.md"),
]) {
  const content = await readFile(join(packageRoot, relativePath), "utf8");
  if (!content.trim()) {
    throw new Error(`Installed Pi ${expectedVersion} has an empty built-in MyPi resource: ${relativePath}.`);
  }
}

const webExtension = await readFile(
  join(packageRoot, "dist", "extensions", "mypi", "web", "index.js"),
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
  join(packageRoot, "dist", "extensions", "mypi", "web", "search.js"),
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
  join(packageRoot, "dist", "extensions", "mypi", "safety.js"),
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
const sandboxBash = await readFile(join(packageRoot, "dist", "core", "tools", "bash.js"), "utf8");
if (
  !sandboxBash.includes("createMyPiSandboxProcessLaunch") ||
  !sandboxBash.includes("MYPI_SANDBOX_DENIAL_CONTROL")
) {
  throw new Error(`Installed Pi ${expectedVersion} does not apply sandboxing at the local BashOperations boundary.`);
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
for (const fragment of ["requireStreaming?: boolean", "mypiQueuedMessageId?: string"]) {
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
  "mypiQueuedMessageId ? { mypiQueuedMessageId }",
  'mypiQueuedMessageMode: "steer"',
  'mypiQueuedMessageMode: "followUp"',
  "mypiShouldContinueAfterThresholdCompaction",
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
for (const fragment of ["## Active Request", "## User Intent Ledger", "## Governing Constraints", "## Working Set", "## Decisions and Error History", "## Open Loops", "## Handoff", "Immediate next operation", "yield-gate:deterministic-fallback"]) {
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
]) {
  if (!checkpoint.includes(fragment)) {
    throw new Error(`Installed Pi ${expectedVersion} is missing durable compaction checkpoint behavior (${fragment}).`);
  }
}
const compactionRecall = await readFile(
  join(packageRoot, "dist", "extensions", "mypi", "compaction-recall.js"),
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
for (const fragment of ["mypiAskUser", 'method: "dismiss"', "targetId: id", 'case "navigate_tree"']) {
  if (!rpcMode.includes(fragment)) {
    throw new Error(`Installed Pi ${expectedVersion} is missing trusted ask_user RPC cleanup (${fragment}).`);
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
for (const fragment of ["You are MyPi", "# Security", "trusted non-echoing prompt or credential manager"]) {
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
for (const relativePath of ["models.js", "compat.js"]) {
  const implementation = await readFile(join(aiPackageRoot, "dist", relativePath), "utf8");
  for (const fragment of ["redactCredentialPayload(context)", "withCredentialRedaction("]) {
    if (!implementation.includes(fragment)) {
      throw new Error(`Installed Pi ${expectedVersion} ${relativePath} is missing the final credential boundary (${fragment}).`);
    }
  }
}

console.log(`Verified Pi ${expectedVersion}, bundled docs/examples without built-in skills, runtime-owned Plan/Goal/archive/web/TUI/safety core with model-aware /reasoning, workspace-confined tools, canonical commentary updates with legacy-name compatibility, the built-in security baseline and packaged minimal prompt replacement, safe web provider selection, isolated fail-closed Anthropic shell sandboxing, suppressed automatic version-update metadata, one-line MyPi identity, outbound credential redaction, /hotkeys, resource viewers, acknowledged tree navigation, skill labels, typed agent settlement including preflight dispatch rejection, and Goal-aware proactive compaction continuation.`);
