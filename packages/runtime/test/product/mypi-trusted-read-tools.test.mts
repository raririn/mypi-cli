import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  isTrustedReadOnlyTool,
  isTrustedUserInteractionTool,
  isTrustedWebReadTool,
} from "../../src/product/mypi-trusted-read-tools.ts";

function productSource(moduleClass: "required" | "capability", name: string) {
  return {
    path: `<product:${moduleClass}:${name}>`,
    source: "product",
    scope: "temporary" as const,
    origin: "top-level" as const,
    productClass: moduleClass,
  };
}

function toolHarness(name: string, sourceInfo: ReturnType<typeof productSource> | Record<string, unknown>) {
  return {
    getAllTools: () => [{ name, sourceInfo }],
  } as unknown as ExtensionAPI;
}

test("trusts only sealed product ask_user as non-mutating interaction", () => {
  const trusted = toolHarness("ask_user", productSource("capability", "ask-user"));
  assert.equal(isTrustedUserInteractionTool(trusted, "ask_user"), true);
  assert.equal(isTrustedReadOnlyTool(trusted, "ask_user"), true);

  const wrongName = toolHarness("question", productSource("capability", "ask-user"));
  assert.equal(isTrustedUserInteractionTool(wrongName, "question"), false);

  const external = toolHarness("ask_user", {
    path: "<inline:ask-user>", source: "inline", scope: "temporary", origin: "top-level",
  });
  assert.equal(isTrustedUserInteractionTool(external, "ask_user"), false);
});

test("rejects malformed or merely claimed product provenance", () => {
  const malformed = toolHarness("ask_user", {
    ...productSource("capability", "ask-user"),
    path: "<inline:ask-user>",
  });
  assert.equal(isTrustedUserInteractionTool(malformed, "ask_user"), false);

  const wrongClass = toolHarness("ask_user", productSource("required", "ask-user"));
  assert.equal(isTrustedUserInteractionTool(wrongClass, "ask_user"), false);
});

test("trusts web reads only from sealed product capabilities", () => {
  const sourceInfo = productSource("capability", "web");
  const pi = {
    getAllTools: () => [
      { name: "web_search", sourceInfo },
      { name: "web_fetch", sourceInfo },
    ],
  } as unknown as ExtensionAPI;
  assert.equal(isTrustedWebReadTool(pi, "web_search"), true);
  assert.equal(isTrustedReadOnlyTool(pi, "web_fetch"), true);

  (pi.getAllTools as () => any[]) = () => [{
    name: "web_search",
    sourceInfo: { ...sourceInfo, path: "<inline:web>" },
  }];
  assert.equal(isTrustedWebReadTool(pi, "web_search"), false);
});

test("trusts sealed compaction recall only as a required product session read", () => {
  const sourceInfo = productSource("required", "compaction-recall");
  const pi = toolHarness("recall_compacted_history", sourceInfo);

  assert.equal(isTrustedReadOnlyTool(pi, "recall_compacted_history"), true);
  assert.equal(isTrustedWebReadTool(pi, "recall_compacted_history"), false);

  (pi.getAllTools as () => any[]) = () => [{
    name: "recall_compacted_history",
    sourceInfo: { ...sourceInfo, productClass: "capability", path: "<product:capability:compaction-recall>" },
  }];
  assert.equal(isTrustedReadOnlyTool(pi, "recall_compacted_history"), false);
});

test("trusts sealed subagent admission in readonly and only lifecycle controls in no-read", () => {
	const sourceInfo = productSource("capability", "subagents");
	for (const name of ["subagent_start", "consult_advisor", "ask_for_review", "subagent_followup", "advisor_followup", "reviewer_followup", "subagent_cancel", "subagent_status", "advisor_evidence"]) {
		const pi = toolHarness(name, sourceInfo);
		assert.equal(isTrustedReadOnlyTool(pi, name), true);
		assert.equal(isTrustedUserInteractionTool(pi, name), name === "subagent_cancel" || name === "subagent_status");
	}
	const spoofed = toolHarness("subagent_start", {
		path: "<inline:subagent_start>", source: "inline", scope: "temporary", origin: "top-level",
	});
	assert.equal(isTrustedReadOnlyTool(spoofed, "subagent_start"), false);
});
