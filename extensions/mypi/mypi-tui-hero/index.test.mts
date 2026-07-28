import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import pizzaHeroExtension, {
  PizzaHeroComponent,
  RESOURCE_COMMANDS,
} from "../../../vendor/pi/packages/coding-agent/src/extensions/mypi/tui-hero/index.ts";
import { pickNewThreadGreeting } from "../../../vendor/pi/packages/coding-agent/src/extensions/mypi/tui-hero/greetings.ts";

setKeybindings(new KeybindingsManager({
  "app.interrupt": { defaultKeys: "escape" },
  "app.clear": { defaultKeys: "ctrl+c" },
  "app.exit": { defaultKeys: "ctrl+d" },
  "app.suspend": { defaultKeys: "ctrl+z" },
  "tui.editor.deleteToLineEnd": { defaultKeys: "ctrl+k" },
  "app.thinking.cycle": { defaultKeys: "shift+tab" },
  "app.model.cycleForward": { defaultKeys: "ctrl+p" },
  "app.model.cycleBackward": { defaultKeys: "ctrl+shift+p" },
  "app.model.select": { defaultKeys: "ctrl+l" },
  "app.tools.expand": { defaultKeys: "ctrl+o" },
  "app.thinking.toggle": { defaultKeys: "ctrl+t" },
  "app.editor.external": { defaultKeys: "ctrl+g" },
  "app.message.followUp": { defaultKeys: "alt+enter" },
  "app.message.dequeue": { defaultKeys: "alt+up" },
  "app.clipboard.pasteImage": { defaultKeys: "ctrl+v" },
}));

const theme = {
  fg(_color: string, text: string) { return `\x1b[36m${text}\x1b[39m`; },
  bold(text: string) { return `\x1b[1m${text}\x1b[22m`; },
} as Theme;

const options = {
  cwd: "/tmp/pizza-project",
  greeting: "Ready when you are",
  modelLabel: "anthropic/claude-pizza",
  thinkingLevel: "high",
  version: "5.0.0-beta.2 (pi-core 0.82.1)",
};

function plain(lines: string[]): string {
  return lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

test("renders a Claude-style pizza card at wide and narrow terminal widths", () => {
  for (let width = 1; width <= 140; width += 1) {
    const lines = new PizzaHeroComponent(theme, options).render(width);
    assert.ok(lines.length > 0);
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `line exceeded ${width} columns`);
  }

  const wide = plain(new PizzaHeroComponent(theme, options).render(108));
  assert.match(wide, /╭── MyPi v5\.0\.0-beta\.2 \(pi-core 0\.82\.1\)/);
  assert.match(wide, /_\.\.\._/);
  assert.match(wide, /Ready when you are/);
  assert.match(wide, /anthropic\/claude-pizza/);
  assert.match(wide, /Thinking: high/);
  assert.match(wide, /\/tmp\/pizza-project/);
  assert.match(wide, /Quick start/);
  assert.match(wide, /MyPi can explain its own features/);
  for (const command of RESOURCE_COMMANDS) assert.match(wide, new RegExp(`/${command.name}`));
  assert.match(wide, /╰─+╯/);

  const narrow = plain(new PizzaHeroComponent(theme, options).render(42));
  assert.ok(narrow.indexOf("Ready when you are") < narrow.indexOf("Quick start"));
});

test("never renders automatic runtime update metadata", () => {
  const rendered = plain(new PizzaHeroComponent(theme, options).render(108));
  assert.doesNotMatch(rendered, /update available|available\)/i);
});

test("tool expansion preserves every detailed built-in startup hint", () => {
  const hero = new PizzaHeroComponent(theme, options);
  const compact = plain(hero.render(108));
  assert.match(compact, /show full startup help and loaded resources/);
  assert.doesNotMatch(compact, /to paste image/);

  hero.setExpanded(true);
  const expanded = plain(hero.render(108));
  for (const expected of [
    "to interrupt",
    "to clear",
    "to exit (empty)",
    "to suspend",
    "to delete to end",
    "to cycle thinking level",
    "to cycle models",
    "to select model",
    "to expand tools",
    "to expand thinking",
    "for external editor",
    "for commands",
    "to run bash (no context)",
    "to queue follow-up",
    "to edit all queued messages",
    "to paste image (with text fallback)",
    "to attach",
  ]) assert.ok(expanded.includes(expected), `missing expanded hint: ${expected}`);
  assert.doesNotMatch(expanded, /show full startup help/);
});

test("filters startup resources and registers authoritative TUI resource viewers", async () => {
  const handlers = new Map<string, (event: unknown, ctx: any) => unknown>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const pi = {
    on(name: string, handler: (event: unknown, ctx: any) => unknown) { handlers.set(name, handler); },
    registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
      commands.set(name, command);
    },
    getThinkingLevel() { return "medium"; },
  } as unknown as ExtensionAPI;
  pizzaHeroExtension(pi);

  let factory: ((tui: unknown, theme: Theme) => PizzaHeroComponent) | undefined;
  const startupFilters: string[][] = [];
  const viewers: Array<{ sections: string[]; title?: string }> = [];
  const notifications: string[] = [];
  const ctx = {
    mode: "tui",
    cwd: "/work/pizza",
    model: { provider: "openai", id: "gpt-pizza" },
    ui: {
      setHeader(next: typeof factory) { factory = next; },
      setStartupResourceSections(sections: readonly string[]) { startupFilters.push([...sections]); },
      async showResourceSections(sections: readonly string[], title?: string) {
        viewers.push({ sections: [...sections], title });
      },
      notify(message: string) { notifications.push(message); },
    },
  };
  await handlers.get("session_start")?.({ reason: "startup" }, ctx);
  assert.ok(factory);
  assert.deepEqual(startupFilters, [["prompts", "themes"]]);
  const registered = plain(factory!({}, theme).render(108));
  assert.match(registered, /openai\/gpt-pizza/);
  assert.match(registered, /Thinking: medium/);

  assert.deepEqual([...commands.keys()], RESOURCE_COMMANDS.map((command) => command.name));
  for (const command of RESOURCE_COMMANDS) await commands.get(command.name)!.handler("", ctx);
  assert.deepEqual(viewers, RESOURCE_COMMANDS.map((command) => ({
    sections: [command.section],
    title: command.title,
  })));
  assert.deepEqual(notifications, []);

  factory = undefined;
  await handlers.get("session_start")?.({ reason: "startup" }, { ...ctx, mode: "rpc" });
  assert.equal(factory, undefined);
  assert.deepEqual(startupFilters, [["prompts", "themes"]]);
});

test("the shared GUI/TUI greeting picker retains time and weekday flavor", () => {
  assert.equal(pickNewThreadGreeting(new Date(2026, 6, 20, 9), () => 0), "Good morning");
  assert.equal(pickNewThreadGreeting(new Date(2026, 6, 20, 9), () => 1), "Monday momentum?");
  assert.equal(pickNewThreadGreeting(new Date(2026, 6, 24, 13), () => 1), "Read-only Friday?");
  assert.equal(pickNewThreadGreeting(new Date(2026, 6, 25, 13), () => 1), "Side project time?");
});
