import { Text } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import type { MessageRenderer, MessageRenderOptions } from "../src/core/extensions/types.ts";
import type { CustomMessage } from "../src/core/messages.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("CustomMessageComponent", () => {
	test("provides output padding to custom renderers and updates it", () => {
		initTheme("dark");
		const optionsSeen: MessageRenderOptions[] = [];
		const renderer: MessageRenderer = (_message, options) => {
			optionsSeen.push(options);
			return new Text("custom", options.outputPad, 0);
		};
		const message: CustomMessage = {
			role: "custom",
			customType: "test",
			content: "custom",
			display: true,
			timestamp: Date.now(),
		};
		const component = new CustomMessageComponent(message, renderer, undefined, 1);

		expect(optionsSeen).toEqual([{ expanded: false, outputPad: 1 }]);
		expect(
			component
				.render(40)
				.map(stripAnsi)
				.some((line) => line.startsWith(" custom")),
		).toBe(true);

		component.setOutputPad(0);

		expect(optionsSeen.at(-1)).toEqual({ expanded: false, outputPad: 0 });
		expect(
			component
				.render(40)
				.map(stripAnsi)
				.some((line) => line.startsWith("custom")),
		).toBe(true);
	});

	test("renders mypi-hook-fired as a labeled row with only the firing lines", () => {
		initTheme("dark");
		const message: CustomMessage = {
			role: "custom",
			customType: "mypi-hook-fired",
			content:
				"[Automated agent-hook notification — not a user message; the user has not sent anything new.]\n- wakeup w1 (after 300s): recheck the build\n- file watch f2 (/tmp/out.log): artifact changed\nAct on this only if it is still relevant. Subagent, goal, and plan results arrive automatically at run boundaries; never schedule wakeups to poll for them.",
			display: true,
			timestamp: Date.now(),
		};
		const lines = new CustomMessageComponent(message, undefined, undefined, 1).render(80).map(stripAnsi);
		const text = lines.join("\n");
		expect(text).toContain("⏰ Hook fired");
		expect(text).toContain("wakeup w1 (after 300s): recheck the build");
		expect(text).toContain("file watch f2 (/tmp/out.log): artifact changed");
		expect(text).not.toContain("Automated agent-hook notification");
		expect(text).not.toContain("never schedule wakeups");
		expect(text).not.toContain("[mypi-hook-fired]");
	});

	test("keeps the generic label rendering for other custom types", () => {
		initTheme("dark");
		const message: CustomMessage = {
			role: "custom",
			customType: "mypi-hook-context",
			content: "[hook context]\ninjected",
			display: true,
			timestamp: Date.now(),
		};
		const text = new CustomMessageComponent(message, undefined, undefined, 1).render(80).map(stripAnsi).join("\n");
		expect(text).toContain("[mypi-hook-context]");
		expect(text).toContain("injected");
	});
});
