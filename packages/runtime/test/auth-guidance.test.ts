import { describe, expect, it } from "vitest";
import {
	formatNoApiKeyFoundMessage,
	formatNoModelSelectedMessage,
	formatNoModelsAvailableMessage,
	getProviderLoginHelp,
} from "../src/core/auth-guidance.ts";

describe("auth guidance", () => {
	it("directs users to login without printing local documentation paths", () => {
		const loginHelp = "Use /login to log into a provider via OAuth or API key.";

		expect(getProviderLoginHelp()).toBe(loginHelp);
		expect(formatNoModelsAvailableMessage()).toBe(`No models available. ${loginHelp}`);
		expect(formatNoModelSelectedMessage()).toBe(
			`No model selected.\n\n${loginHelp}\n\nThen use /model to select a model.`,
		);
		expect(formatNoApiKeyFoundMessage("openai")).toBe(`No API key found for openai.\n\n${loginHelp}`);
	});
});
