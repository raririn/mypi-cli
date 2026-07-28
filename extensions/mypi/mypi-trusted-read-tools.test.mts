import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  isTrustedReadOnlyTool,
  isTrustedUserInteractionTool,
  isTrustedWebReadTool,
} from "./mypi-trusted-read-tools.mts";

async function createCoreTool(packageName = "@mypi/core", toolName = "ask_user") {
  const root = await mkdtemp(join(tmpdir(), "mypi-trusted-tool-"));
  const extensionPath = join(root, "extensions", "mypi-ask-user.ts");
  await mkdir(join(root, "extensions"), { recursive: true });
  await writeFile(extensionPath, "export default function askUser() {}\n", "utf8");
  await writeFile(join(root, "package.json"), `${JSON.stringify({
    name: packageName,
    pi: { extensions: ["./extensions/mypi-ask-user.ts"] },
  })}\n`, "utf8");
  const pi = {
    getAllTools: () => [{
      name: toolName,
      sourceInfo: {
        path: extensionPath,
        source: root,
        scope: "user",
        origin: "package",
        baseDir: root,
      },
    }],
  } as unknown as ExtensionAPI;
  return { pi, root, extensionPath };
}

test("trusts only the bundled core ask_user entrypoint as non-mutating interaction", async () => {
  const trusted = await createCoreTool();
  assert.equal(isTrustedUserInteractionTool(trusted.pi, "ask_user"), true);
  assert.equal(isTrustedReadOnlyTool(trusted.pi, "ask_user"), true);

  const wrongPackage = await createCoreTool("third-party-tools");
  assert.equal(isTrustedUserInteractionTool(wrongPackage.pi, "ask_user"), false);

  const wrongName = await createCoreTool("@mypi/core", "question");
  assert.equal(isTrustedUserInteractionTool(wrongName.pi, "question"), false);
});

test("rejects a same-named tool whose source is not the manifest entrypoint", async () => {
  const { pi, root } = await createCoreTool();
  const spoofPath = join(root, "extensions", "spoof.ts");
  await writeFile(spoofPath, "export default function spoof() {}\n", "utf8");
  (pi.getAllTools as () => any[]) = () => [{
    name: "ask_user",
    sourceInfo: {
      path: spoofPath,
      source: root,
      scope: "user",
      origin: "package",
      baseDir: root,
    },
  }];
  assert.equal(isTrustedUserInteractionTool(pi, "ask_user"), false);
});

test("trusts web reads only at the exact runtime-owned MyPi core entrypoint", () => {
  const sourceInfo = {
    path: "<builtin:mypi-core>",
    source: "builtin",
    scope: "temporary" as const,
    origin: "top-level" as const,
  };
  const pi = {
    getAllTools: () => [
      { name: "web_search", sourceInfo },
      { name: "web_fetch", sourceInfo },
    ],
  } as unknown as ExtensionAPI;
  assert.equal(isTrustedWebReadTool(pi, "web_search"), true);
  assert.equal(isTrustedReadOnlyTool(pi, "web_fetch"), true);

  (pi.getAllTools as () => any[]) = () => [{
    name: "web_search",
    sourceInfo: { ...sourceInfo, path: "<inline:mypi-core>" },
  }];
  assert.equal(isTrustedWebReadTool(pi, "web_search"), false);
});
