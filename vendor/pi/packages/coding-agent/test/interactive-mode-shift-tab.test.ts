import { describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type ShiftTabTarget = "thinking" | "safety";

const prototype = InteractiveMode.prototype as unknown as {
	setShiftTabTarget(this: ShiftTabContext, target: ShiftTabTarget): void;
	handleShiftTabCommand(this: ShiftTabContext, value?: string): Promise<void>;
};

interface ShiftTabContext {
	keybindings: KeybindingsManager;
	setShiftTabTarget(target: ShiftTabTarget): void;
	showExtensionSelector(title: string, options: string[]): Promise<string | undefined>;
	showStatus(message: string): void;
	showWarning(message: string): void;
}

function createContext(): ShiftTabContext {
	const context = {
		keybindings: new KeybindingsManager({
			"app.thinking.cycle": "ctrl+y",
			"app.safety.cycle": ["shift+tab", "ctrl+u"],
		}),
		setShiftTabTarget(target: ShiftTabTarget) {
			prototype.setShiftTabTarget.call(context, target);
		},
		showExtensionSelector: vi.fn(async () => undefined),
		showStatus: vi.fn(),
		showWarning: vi.fn(),
	} satisfies ShiftTabContext;
	return context;
}

describe("InteractiveMode /shift-tab", () => {
	it("moves only Shift+Tab to the selected action and preserves custom bindings", async () => {
		const context = createContext();

		await prototype.handleShiftTabCommand.call(context, "thinking");

		expect(context.keybindings.getKeys("app.thinking.cycle")).toEqual(["ctrl+y", "shift+tab"]);
		expect(context.keybindings.getKeys("app.safety.cycle")).toEqual(["ctrl+u"]);
		expect(context.showStatus).toHaveBeenCalledWith("Shift+Tab now cycles reasoning levels");
		expect(context.showWarning).not.toHaveBeenCalled();

		await prototype.handleShiftTabCommand.call(context, "safety");

		expect(context.keybindings.getKeys("app.thinking.cycle")).toEqual(["ctrl+y"]);
		expect(context.keybindings.getKeys("app.safety.cycle")).toEqual(["ctrl+u", "shift+tab"]);
	});

	it("rejects invalid arguments without changing the active binding", async () => {
		const context = createContext();

		await prototype.handleShiftTabCommand.call(context, "other");

		expect(context.keybindings.getKeys("app.thinking.cycle")).toEqual(["ctrl+y"]);
		expect(context.keybindings.getKeys("app.safety.cycle")).toEqual(["shift+tab", "ctrl+u"]);
		expect(context.showWarning).toHaveBeenCalledWith("Usage: /shift-tab [thinking|safety]");
	});
});
