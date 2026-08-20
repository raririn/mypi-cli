import assert from "node:assert/strict";
import test from "node:test";
import {
  WEB_FETCH_PROMPT_GUIDELINES,
  WEB_SEARCH_PROMPT_GUIDELINES,
} from "../../packages/runtime/src/extensions/mypi/web/index.ts";

test("web prompt policy requires opened authoritative sources and honest limitations", () => {
  const search = WEB_SEARCH_PROMPT_GUIDELINES.join("\n");
  assert.match(search, /current, externally verifiable, version-specific/);
  assert.match(search, /snippets are discovery leads, not sufficient evidence/);
  assert.match(search, /Open the relevant source with web_fetch/);
  assert.match(search, /Prefer primary sources for technical claims/);
  assert.match(search, /Never invent a URL, citation, quotation/);

  const fetch = WEB_FETCH_PROMPT_GUIDELINES.join("\n");
  assert.match(fetch, /actually supports the claim/);
  assert.match(fetch, /date or version context/);
  assert.match(fetch, /unavailable, incomplete, truncated, or conflicting/);
  assert.match(fetch, /state the limitation instead of filling the gap/);
});
