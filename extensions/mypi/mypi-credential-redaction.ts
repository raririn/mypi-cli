import { redactCredentialPayload } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const CREDENTIAL_REDACTION_WARNING =
  "MyPi redacted a credential-like value from this run before model transmission. Local files and session history were not changed.";

export default function credentialRedactionExtension(pi: ExtensionAPI): void {
  let warnedForRun = false;

  const warnIfAffected = (value: unknown, ctx: ExtensionContext): void => {
    if (warnedForRun || !redactCredentialPayload(value).changed) return;
    warnedForRun = true;
    ctx.ui.notify(CREDENTIAL_REDACTION_WARNING, "warning");
  };

  pi.on("before_agent_start", (event, ctx) => {
    warnedForRun = false;
    warnIfAffected({ prompt: event.prompt, systemPrompt: event.systemPrompt }, ctx);
  });

  pi.on("context", (event, ctx) => {
    warnIfAffected(event.messages, ctx);
  });

  // The patched Models boundary also applies a final copy-on-write pass after
  // all payload hooks. This handler provides early defense and catches values
  // introduced during provider serialization while preserving the final guard.
  pi.on("before_provider_request", (event, ctx) => {
    const result = redactCredentialPayload(event.payload);
    if (result.changed) warnIfAffected(event.payload, ctx);
    return result.value;
  });
}
