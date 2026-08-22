import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class Lines implements Component {
	lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

function captureWrites(terminal: VirtualTerminal): string[] {
	const writes: string[] = [];
	const original = terminal.write.bind(terminal);
	terminal.write = (data: string) => {
		writes.push(data);
		original(data);
	};
	return writes;
}

describe("TUI scrollback preservation", () => {
	it("does not clear scrollback when a line above the viewport changes during streaming", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const content = new Lines(Array.from({ length: 30 }, (_, i) => `line-${i}`));
		tui.addChild(content);
		tui.start();
		await terminal.waitForRender();

		const writes = captureWrites(terminal);
		// Streaming shape: history above the viewport re-renders while new
		// content appends at the bottom.
		content.lines = [...content.lines];
		content.lines[0] = "line-0-rewrapped";
		content.lines.push("line-30");
		tui.requestRender();
		await terminal.waitForRender();

		const output = writes.join("");
		assert.ok(!output.includes("\x1b[3J"), "scrollback must not be cleared");
		assert.ok(!output.includes("\x1b[2J"), "screen must not be fully cleared");
		assert.ok(
			terminal.getViewport().some((line) => line.includes("line-30")),
			"appended line must reach the viewport",
		);

		tui.stop();
	});

	it("skips repainting when every change is above the viewport", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const content = new Lines(Array.from({ length: 30 }, (_, i) => `line-${i}`));
		tui.addChild(content);
		tui.start();
		await terminal.waitForRender();

		const writes = captureWrites(terminal);
		content.lines = [...content.lines];
		content.lines[1] = "line-1-changed";
		tui.requestRender();
		await terminal.waitForRender();

		const output = writes.join("");
		assert.ok(!output.includes("\x1b[3J"), "scrollback must not be cleared");
		assert.ok(
			terminal.getViewport().some((line) => line.includes("line-29")),
			"viewport content must remain intact",
		);

		tui.stop();
	});

	it("keeps the legacy full clear when preserve-scrollback is disabled", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		tui.setPreserveScrollback(false);
		const content = new Lines(Array.from({ length: 30 }, (_, i) => `line-${i}`));
		tui.addChild(content);
		tui.start();
		await terminal.waitForRender();

		const writes = captureWrites(terminal);
		content.lines = [...content.lines];
		content.lines[0] = "line-0-rewrapped";
		tui.requestRender();
		await terminal.waitForRender();

		assert.ok(writes.join("").includes("\x1b[3J"), "legacy mode clears scrollback");

		tui.stop();
	});
});
