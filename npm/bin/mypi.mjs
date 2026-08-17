#!/usr/bin/env node

import { ensureBundledProfile } from "../lib/ensure-profile.mjs";

const command = process.argv[2];
if (command === "__install-profile") {
  const result = await ensureBundledProfile();
  process.stdout.write(`${result.changed ? "Activated" : "Verified"} bundled @mypi/core at ${result.source}.\n`);
  process.exit(0);
}

const skipsProfileActivation =
  command === "--version"
  || command === "-v"
  || command === "__remote-info"
  || command === "__remote-node-eval"
  || command === "__remote-run"
  || command === "__remote-workspace";

if (!skipsProfileActivation) {
  // Every normal launch converges only recognized MyPi-managed package paths
  // onto this installation's bundled core. Unknown/user packages are retained.
  await ensureBundledProfile();
}

await import("../scripts/mypi.mjs");
