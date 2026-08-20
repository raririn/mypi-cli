import { homedir } from "node:os";
import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionUIContext } from "../../../core/extensions/types.ts";
import { keyText } from "../../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import { pickNewThreadGreeting } from "./greetings.ts";

const MAX_BOX_WIDTH = 108;
const WIDE_LAYOUT_MIN_WIDTH = 78;
const COLUMN_GAP = 3;
const LEFT_COLUMN_WIDTH = 31;
const STARTUP_RESOURCE_SECTIONS = ["prompts", "themes"] as const;

export const RESOURCE_COMMANDS = [
	{ name: "show_context", section: "context", title: "Loaded context" },
	{ name: "show_extensions", section: "extensions", title: "Loaded extensions" },
	{ name: "show_skills", section: "skills", title: "Loaded skills" },
] as const;

const PIZZA_ART = [
	"       _..._       ",
	"    .-'     '-.    ",
	"  .' o  *  o  '.  ",
	" / *  o  *  o  * \\",
	"| o  *  o  *  o  |",
	" \\ *  o  *  o  * /",
	"  '. o  *  o  .'  ",
	"    '-._____.-'    ",
] as const;

export interface PizzaHeroOptions {
	readonly cwd: string;
	readonly greeting: string;
	readonly modelLabel: string;
	readonly thinkingLevel: string;
	readonly version?: string;
}

/** MyPi startup header with Claude Code-style framing and expansion behavior. */
export class PizzaHeroComponent implements Component {
	private expanded = false;
	private readonly theme: Theme;
	private readonly options: PizzaHeroOptions;

	constructor(theme: Theme, options: PizzaHeroOptions) {
		this.theme = theme;
		this.options = options;
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		if (width < 8) return [truncateToWidth(this.theme.fg("accent", "MyPi"), width, "")];

		const boxWidth = Math.min(width, MAX_BOX_WIDTH);
		const innerWidth = boxWidth - 2;
		const contentWidth = Math.max(1, innerWidth - 2);
		const body =
			contentWidth >= WIDE_LAYOUT_MIN_WIDTH
				? this.renderWideBody(contentWidth)
				: this.renderStackedBody(contentWidth);

		return [
			this.renderTopBorder(innerWidth),
			...body.map((line) => this.renderBodyLine(line, innerWidth)),
			this.theme.fg("borderAccent", `╰${"─".repeat(innerWidth)}╯`),
		];
	}

	invalidate(): void {
		// Rendering is stateless so theme/keybinding changes are picked up directly.
	}

	private renderTopBorder(innerWidth: number): string {
		const labelWidth = Math.max(1, innerWidth - 4);
		const runtimeVersion = this.options.version ?? process.env.MYPI_RUNTIME_DISPLAY_VERSION;
		const label = truncateToWidth(runtimeVersion ? `MyPi v${runtimeVersion}` : "MyPi", labelWidth, "");
		const used = 3 + visibleWidth(label) + 1;
		const trailing = "─".repeat(Math.max(0, innerWidth - used));
		return [
			this.theme.fg("borderAccent", "╭── "),
			this.theme.bold(this.theme.fg("accent", label)),
			this.theme.fg("borderAccent", ` ${trailing}╮`),
		].join("");
	}

	private renderBodyLine(content: string, innerWidth: number): string {
		const available = Math.max(0, innerWidth - 2);
		const fitted = padAnsi(content, available);
		return `${this.theme.fg("borderAccent", "│")} ${fitted} ${this.theme.fg("borderAccent", "│")}`;
	}

	private renderWideBody(contentWidth: number): string[] {
		const rightWidth = contentWidth - LEFT_COLUMN_WIDTH - COLUMN_GAP;
		const left = this.leftColumn(LEFT_COLUMN_WIDTH, false);
		const right = this.helpColumn(rightWidth);
		const rowCount = Math.max(left.length, right.length);
		const lines: string[] = [];

		for (let index = 0; index < rowCount; index += 1) {
			const leftLine = padAnsi(left[index] ?? "", LEFT_COLUMN_WIDTH);
			const rightLine = truncateToWidth(right[index] ?? "", rightWidth, "");
			lines.push(`${leftLine}${" ".repeat(COLUMN_GAP)}${rightLine}`);
		}
		return lines;
	}

	private renderStackedBody(contentWidth: number): string[] {
		return [...this.leftColumn(contentWidth, true), "", ...this.helpColumn(contentWidth)];
	}

	private leftColumn(width: number, center: boolean): string[] {
		const pizza = PIZZA_ART.map((line) => {
			const colored = colorPizza(line, this.theme);
			return center ? centerAnsi(colored, width) : colored;
		});
		const metadata = [
			this.theme.fg("muted", this.options.modelLabel),
			this.theme.fg("dim", `Thinking: ${this.options.thinkingLevel}`),
			this.theme.fg("dim", displayPath(this.options.cwd)),
		].flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));

		return [
			"",
			...pizza,
			"",
			centerAnsi(this.theme.bold(this.theme.fg("accent", this.options.greeting)), width),
			...metadata.map((line) => (center ? centerAnsi(line, width) : line)),
			"",
		];
	}

	private helpColumn(width: number): string[] {
		const lines = [
			this.theme.bold(this.theme.fg("mdHeading", "Quick start")),
			this.theme.fg("borderMuted", "─".repeat(Math.max(1, width))),
			...startupHints(this.expanded, this.theme),
			resourceCommandHint(this.theme),
			"",
			...(this.expanded
				? []
				: [
						this.theme.fg(
							"dim",
							`Press ${keyText("app.tools.expand")} to show full startup help and loaded resources.`,
						),
						"",
					]),
			this.theme.fg(
				"dim",
				"MyPi can explain its own features and look up its upstream runtime docs. Ask how to use or extend MyPi.",
			),
		];
		return lines.flatMap((line) => (line ? wrapTextWithAnsi(line, Math.max(1, width)) : [""]));
	}
}

export default function pizzaHeroExtension(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const greeting = pickNewThreadGreeting();
		const modelLabel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "No model selected";
		const thinkingLevel = pi.getThinkingLevel();

		ctx.ui.setStartupResourceSections?.(STARTUP_RESOURCE_SECTIONS);
		ctx.ui.setHeader(
			(_tui, theme) =>
				new PizzaHeroComponent(theme, {
					cwd: ctx.cwd,
					greeting,
					modelLabel,
					thinkingLevel,
				}),
		);
	});

	for (const command of RESOURCE_COMMANDS) {
		pi.registerCommand(command.name, {
			description: `Show ${command.title.toLowerCase()} in the MyPi TUI`,
			handler: async (args, ctx) => {
				if (args.trim() === "--help") {
					ctx.ui.notify(`/${command.name} — ${command.title}. TUI-only, read-only, and session-local.`, "info");
					return;
				}
				if (args.trim()) {
					ctx.ui.notify(`Usage: /${command.name}`, "warning");
					return;
				}
				if (ctx.mode !== "tui" || !ctx.ui.showResourceSections) {
					ctx.ui.notify(`/${command.name} is available in the MyPi TUI only.`, "warning");
					return;
				}
				await ctx.ui.showResourceSections([command.section], command.title);
			},
		});
	}
}

function resourceCommandHint(theme: Theme): string {
	const commands = RESOURCE_COMMANDS.map((command) => theme.fg("mdCode", `/${command.name}`));
	return `${theme.fg("muted", "Resources:")} ${commands.join(theme.fg("muted", " · "))}`;
}

function startupHints(expanded: boolean, theme: Theme): string[] {
	const rawHint = (key: string, description: string) => theme.fg("dim", key) + theme.fg("muted", ` ${description}`);
	const hint = (binding: Parameters<typeof keyText>[0], description: string) => rawHint(keyText(binding), description);

	if (expanded) {
		return [
			hint("app.interrupt", "to interrupt"),
			hint("app.clear", "to clear"),
			rawHint(`${keyText("app.clear")} twice`, "to exit"),
			hint("app.exit", "to exit (empty)"),
			hint("app.suspend", "to suspend"),
			hint("tui.editor.deleteToLineEnd", "to delete to end"),
			hint("app.safety.cycle", "to cycle safety mode"),
			rawHint(`${keyText("app.model.cycleForward")}/${keyText("app.model.cycleBackward")}`, "to cycle models"),
			hint("app.model.select", "to select model"),
			hint("app.tools.expand", "to expand tools"),
			hint("app.thinking.toggle", "to expand thinking"),
			hint("app.editor.external", "for external editor"),
			rawHint("/", "for commands"),
			rawHint("!", "to run bash"),
			rawHint("!!", "to run bash (no context)"),
			hint("app.message.followUp", "to queue follow-up"),
			hint("app.message.dequeue", "to edit all queued messages"),
			hint("app.clipboard.pasteImage", "to paste image (with text fallback)"),
			rawHint("drop files", "to attach"),
		];
	}

	return [
		[
			hint("app.interrupt", "interrupt"),
			rawHint(`${keyText("app.clear")}/${keyText("app.exit")}`, "clear/exit"),
			rawHint("/", "commands"),
			rawHint("!", "bash"),
			hint("app.tools.expand", "more"),
		].join(theme.fg("muted", " · ")),
	];
}

function colorPizza(line: string, theme: Theme): string {
	return (line.match(/o|\*|[^o*]+/g) ?? [])
		.map((part) => {
			if (part === "o") return theme.fg("error", part);
			if (part === "*") return theme.fg("accent", part);
			return theme.fg("warning", part);
		})
		.join("");
}

function padAnsi(value: string, width: number): string {
	const truncated = truncateToWidth(value, Math.max(0, width), "");
	return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

function centerAnsi(value: string, width: number): string {
	const truncated = truncateToWidth(value, Math.max(0, width), "");
	const padding = Math.max(0, width - visibleWidth(truncated));
	const left = Math.floor(padding / 2);
	return `${" ".repeat(left)}${truncated}`;
}

function displayPath(cwd: string): string {
	const home = homedir();
	if (cwd === home) return "~";
	if (cwd.startsWith(`${home}/`) || cwd.startsWith(`${home}\\`)) return `~${cwd.slice(home.length)}`;
	return cwd;
}

/**
 * TUI-local chrome for a hosted session (FEAT-061 Phase B).
 *
 * With a daemon-hosted session, this extension executes inside the engine
 * child whose UI context is headless, so its `session_start` handler
 * deliberately does nothing there. The hero header and the read-only
 * resource viewer commands are presentation owned by the TUI process, so the
 * hosted TUI binds them here — through its own `ExtensionUIContext`, exactly
 * as the embedded handler would — instead of losing them to the wire.
 */
export function bindHostedTuiChrome(
	ui: ExtensionUIContext,
	info: { cwd: string; modelLabel: string; thinkingLevel: string },
): void {
	ui.setStartupResourceSections?.([...STARTUP_RESOURCE_SECTIONS]);
	ui.setHeader(
		(_tui, theme) =>
			new PizzaHeroComponent(theme, {
				cwd: info.cwd,
				greeting: pickNewThreadGreeting(),
				modelLabel: info.modelLabel,
				thinkingLevel: info.thinkingLevel,
			}),
	);
}

/**
 * Runs a resource viewer command against the TUI's own UI context. Returns
 * false when the text is not one of this extension's viewer commands, so the
 * caller falls through to the engine.
 */
export async function runHostedResourceCommand(ui: ExtensionUIContext, text: string): Promise<boolean> {
	if (!text.startsWith("/")) return false;
	const spaceIndex = text.indexOf(" ");
	const name = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
	const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();
	const command = RESOURCE_COMMANDS.find((candidate) => candidate.name === name);
	if (!command || !ui.showResourceSections) return false;
	if (args && args !== "--help") {
		ui.notify(`Usage: /${command.name}`, "warning");
		return true;
	}
	if (args === "--help") {
		ui.notify(`/${command.name} — ${command.title}. TUI-only, read-only, and session-local.`, "info");
		return true;
	}
	await ui.showResourceSections([command.section], command.title);
	return true;
}
