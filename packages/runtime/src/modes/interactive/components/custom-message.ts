import type { TextContent } from "@earendil-works/pi-ai";
import type { Component } from "@earendil-works/pi-tui";
import { Box, Container, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
import type { MessageRenderer } from "../../../core/extensions/types.ts";
import type { CustomMessage } from "../../../core/messages.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";

/**
 * Component that renders a custom message entry from extensions.
 * Uses distinct styling to differentiate from user messages.
 */
export class CustomMessageComponent extends Container {
	private message: CustomMessage<unknown>;
	private customRenderer?: MessageRenderer;
	private box: Box;
	private customComponent?: Component;
	private markdownTheme: MarkdownTheme;
	private _expanded = false;
	private outputPad: number;

	constructor(
		message: CustomMessage<unknown>,
		customRenderer?: MessageRenderer,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
	) {
		super();
		this.message = message;
		this.customRenderer = customRenderer;
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;

		this.addChild(new Spacer(1));

		// Create box with purple background (used for default rendering)
		this.box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));

		this.rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this._expanded !== expanded) {
			this._expanded = expanded;
			this.rebuild();
		}
	}

	setOutputPad(outputPad: number): void {
		if (this.outputPad !== outputPad) {
			this.outputPad = outputPad;
			this.rebuild();
		}
	}

	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}

	private rebuild(): void {
		// Remove previous content component
		if (this.customComponent) {
			this.removeChild(this.customComponent);
			this.customComponent = undefined;
		}
		this.removeChild(this.box);

		// Try custom renderer first - it handles its own styling
		if (this.customRenderer) {
			try {
				const component = this.customRenderer(
					this.message,
					{ expanded: this._expanded, outputPad: this.outputPad },
					theme,
				);
				if (component) {
					// Custom renderer provides its own styled component
					this.customComponent = component;
					this.addChild(component);
					return;
				}
			} catch {
				// Fall through to default rendering
			}
		}

		// Default rendering uses our box
		this.addChild(this.box);
		this.box.clear();
		if (this.message.customType === "mypi-subagent-results" && this.renderSubagentResults()) return;
		if (this.message.customType === "mypi-hook-fired" && this.renderHookFired()) return;

		// Default rendering: label + content
		const label = theme.fg("customMessageLabel", `\x1b[1m[${this.message.customType}]\x1b[22m`);
		this.box.addChild(new Text(label, 0, 0));
		this.box.addChild(new Spacer(1));
		this.box.addChild(
			new Markdown(this.contentText(), 0, 0, this.markdownTheme, {
				color: (text: string) => theme.fg("customMessageText", text),
			}),
		);
	}

	private contentText(): string {
		if (typeof this.message.content === "string") return this.message.content;
		return this.message.content
			.filter((c): c is TextContent => c.type === "text")
			.map((c) => c.text)
			.join("\n");
	}

	/** Fired agent hooks: a labeled row with just the firing lines — the
	 *  notification boilerplate is model-facing framing, not user information. */
	private renderHookFired(): boolean {
		const firings = this.contentText()
			.split("\n")
			.filter((line) => line.startsWith("- "))
			.map((line) => line.slice(2));
		if (firings.length === 0) return false;
		this.box.addChild(new Text(theme.fg("customMessageLabel", "\x1b[1m⏰ Hook fired\x1b[22m"), 0, 0));
		this.box.addChild(new Spacer(1));
		this.box.addChild(
			new Markdown(firings.join("\n"), 0, 0, this.markdownTheme, {
				color: (text: string) => theme.fg("customMessageText", text),
			}),
		);
		return true;
	}

	private renderSubagentResults(): boolean {
		const details = this.message.details && typeof this.message.details === "object"
			? this.message.details as { results?: unknown }
			: undefined;
		if (!Array.isArray(details?.results) || details.results.length === 0) return false;
		for (const raw of details.results) {
			const result = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
			const title = result.role === "advisor"
				? "Advisor finished"
				: result.role === "review" || result.role === "reviewer"
					? "Reviewer finished"
					: "Subagent finished";
			const label = typeof result.label === "string" && result.label.trim() ? ` — ${result.label.trim()}` : "";
			this.box.addChild(new Text(theme.fg("customMessageLabel", `\x1b[1m${title}\x1b[22m${label}`), 0, 0));
			if (!this._expanded) continue;
			const answer = typeof result.answer === "string" && result.answer.trim()
				? result.answer.trim()
				: "No returned output.";
			this.box.addChild(new Spacer(1));
			this.box.addChild(new Markdown(answer, 0, 0, this.markdownTheme, {
				color: (text: string) => theme.fg("customMessageText", text),
			}));
		}
		return true;
	}
}
