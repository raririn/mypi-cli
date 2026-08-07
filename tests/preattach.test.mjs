import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePreattachEligible } from "../scripts/mypi-preattach.mjs";

test("plain launch is eligible with no session or model", () => {
  assert.deepEqual(parsePreattachEligible([]), { sessionId: undefined, model: undefined });
});

test("--session resume is eligible", () => {
  assert.deepEqual(parsePreattachEligible(["--session", "abc-123"]), { sessionId: "abc-123", model: undefined });
});

test("--session with --model is eligible", () => {
  assert.deepEqual(parsePreattachEligible(["--session", "abc", "--model", "gpt-x"]), {
    sessionId: "abc",
    model: "gpt-x",
  });
});

test("any other flag disables pre-attach", () => {
  assert.equal(parsePreattachEligible(["--no-tools"]), undefined);
  assert.equal(parsePreattachEligible(["--session", "abc", "--provider", "openai"]), undefined);
  assert.equal(parsePreattachEligible(["do something"]), undefined);
});

test("missing flag values disable pre-attach", () => {
  assert.equal(parsePreattachEligible(["--session"]), undefined);
  assert.equal(parsePreattachEligible(["--session", "--model"]), undefined);
});
