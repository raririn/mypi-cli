import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import identityExtension, { MYPI_IDENTITY_LINE } from "./mypi-identity.ts";

type Handler = (event: { systemPrompt: string }) => unknown;

function createHarness() {
  let handler: Handler | undefined;
  const pi = {
    on(name: string, candidate: Handler) {
      if (name === "before_agent_start") handler = candidate;
    },
  } as unknown as ExtensionAPI;
  identityExtension(pi);
  return (systemPrompt: string) => handler?.({ systemPrompt });
}

test("adds the single-line MyPi identity to an inherited prompt", () => {
  const emit = createHarness();
  const result = emit("custom prompt") as { systemPrompt: string };
  assert.equal(result.systemPrompt, `custom prompt\n\n${MYPI_IDENTITY_LINE}`);
});

test("does not duplicate an identity already supplied by the base prompt", () => {
  const emit = createHarness();
  assert.equal(emit(`${MYPI_IDENTITY_LINE}\nbase`), undefined);
});
