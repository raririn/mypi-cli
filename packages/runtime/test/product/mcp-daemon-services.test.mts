import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	listMcpServerSettings,
	probeMcpWizardTarget,
	removeMcpWizardServer,
	saveMcpWizardServer,
	setMcpWizardServerEnabled,
	testMcpWizardServer,
} from "../../src/product/mcp-daemon-services.ts";

const fixture = fileURLToPath(new URL("./fixtures/mcp-fixture-server.mjs", import.meta.url));

test("MCP daemon wizard reuses validation, redaction, persistence, and live catalog testing", async () => {
	const root = await mkdtemp(join(tmpdir(), "mypi-mcp-daemon-settings-"));
	const path = join(root, "config.yaml");
	try {
		const probed = await probeMcpWizardTarget(`${process.execPath} ${fixture}`);
		assert.equal(probed.transport, "stdio");
		assert.equal(probed.status, "ready");

		let listed = await saveMcpWizardServer({
			serverId: "fixture",
			description: "fixture server",
			transport: "stdio",
			target: `${process.execPath} ${fixture}`,
		}, path);
		assert.equal(listed.servers.length, 1);
		assert.equal(listed.servers[0]?.serverId, "fixture");
		assert.equal("env" in (listed.servers[0] ?? {}), false, "raw env values are not exposed");

		const live = await testMcpWizardServer("fixture", { path, workspaceCwd: root, agentDir: root });
		assert.equal(live.status, "ready");
		assert.ok(Array.isArray(live.records));

		listed = await setMcpWizardServerEnabled("fixture", false, path);
		assert.equal(listed.servers[0]?.enabled, false);
		listed = await removeMcpWizardServer("fixture", path);
		assert.equal(listed.servers.length, 0);
		assert.doesNotMatch(await readFile(path, "utf8"), /fixture/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
