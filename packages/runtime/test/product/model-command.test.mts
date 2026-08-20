import assert from "node:assert/strict";
import test from "node:test";
import { parseModelCommandArguments } from "../../src/core/model-command.ts";

test("/model is session-local unless either accepted argument order supplies --global", () => {
	assert.deepEqual(parseModelCommandArguments(""), { persistGlobal: false });
	assert.deepEqual(parseModelCommandArguments("openai/gpt-5"), {
		persistGlobal: false,
		modelReference: "openai/gpt-5",
	});
	assert.deepEqual(parseModelCommandArguments("--global openai/gpt-5"), {
		persistGlobal: true,
		modelReference: "openai/gpt-5",
	});
	assert.deepEqual(parseModelCommandArguments("openai/gpt-5 --global"), {
		persistGlobal: true,
		modelReference: "openai/gpt-5",
	});
	assert.deepEqual(parseModelCommandArguments("--global"), { persistGlobal: true });
	assert.match((parseModelCommandArguments("--global --global openai/gpt-5") as { error: string }).error, /Usage/);
	assert.match((parseModelCommandArguments("--unknown openai/gpt-5") as { error: string }).error, /Usage/);
});
