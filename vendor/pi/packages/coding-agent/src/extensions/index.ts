import type { ExtensionAPI, InlineExtension } from "../core/extensions/types.ts";
import llamaExtension from "./llama/index.ts";
import archiveManageExtension from "./mypi/archive-manage.ts";
import planGoalExtension from "./mypi/plan-goal.ts";
import myPiResourcesExtension from "./mypi/resources.ts";
import sandboxExtension from "./mypi/sandbox.ts";
import pizzaHeroExtension from "./mypi/tui-hero/index.ts";
import webSearchExtension from "./mypi/web/index.ts";

async function myPiCoreExtension(pi: ExtensionAPI): Promise<void> {
	planGoalExtension(pi);
	archiveManageExtension(pi);
	pizzaHeroExtension(pi);
	myPiResourcesExtension(pi);
	sandboxExtension(pi);
	await webSearchExtension(pi);
}

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, hidden: true, builtIn: true },
	{ name: "mypi-core", factory: myPiCoreExtension, hidden: true, builtIn: true },
];
