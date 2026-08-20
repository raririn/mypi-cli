import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { hasProductAuthority } from "../src/core/source-info.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { productModules, productModulesForProfile } from "../src/product/index.ts";
import { getProductModuleClass } from "../src/product/registry.ts";

describe("sealed MyPi product composition", () => {
	const roots: string[] = [];

	afterEach(() => {
		while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
	});

	it("classifies only registry-created modules as product authority", () => {
		expect(getProductModuleClass(productModules.find((module) => module.name === "goal")!)).toBe("required");
		expect(getProductModuleClass({
			name: "goal",
			factory: () => {},
			builtIn: true,
			hidden: true,
		})).toBeUndefined();
	});

	it("keeps the restricted Chat profile disjoint from coding modules", () => {
		expect(productModulesForProfile("chat").map((module) => module.name)).toEqual(["chat"]);
		expect(productModulesForProfile("none")).toEqual([]);
		expect(productModulesForProfile("coding")).toBe(productModules);
	});

	it("ignores retired @mypi/core resources even when the SDK bypasses npm convergence", async () => {
		const root = mkdtempSync(join(tmpdir(), "mypi-product-registry-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		const legacyRoot = join(root, "legacy-core");
		const extensionDirectory = join(legacyRoot, "extensions");
		mkdirSync(extensionDirectory, { recursive: true });
		writeFileSync(
			join(legacyRoot, "package.json"),
			`${JSON.stringify({
				name: "@mypi/core",
				pi: { extensions: ["./extensions/spoof.ts"] },
			})}\n`,
		);
		writeFileSync(
			join(extensionDirectory, "spoof.ts"),
			"export default pi => pi.registerTool({ name: 'spoof_product', label: 'Spoof', description: 'spoof', parameters: { type: 'object' }, execute: async () => ({ content: [], details: {} }) });\n",
		);
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ packages: [legacyRoot] })}\n`);

		const settingsManager = SettingsManager.create(root, agentDir, { projectTrusted: true });
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir,
			settingsManager,
			extensionFactories: [...productModules],
			noExtensions: true,
		});
		await loader.reload();

		const extensions = loader.getExtensions().extensions;
		expect(extensions.some((extension) => extension.path.includes("legacy-core"))).toBe(false);
		expect(extensions.flatMap((extension) => [...extension.tools.keys()])).not.toContain("spoof_product");
		const goal = extensions.find((extension) => extension.path === "<product:required:goal>");
		expect(hasProductAuthority(goal?.sourceInfo, ["required"])).toBe(true);
	});
});
