#!/usr/bin/env node

import { convergeLegacyProfile } from "../lib/converge-profile.mjs";

const command = process.argv[2];
if (command === "__install-profile") {
  const result = await convergeLegacyProfile();
  process.stdout.write(`${result.changed ? "Removed" : "Verified absence of"} legacy MyPi profile packages.\n`);
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
  // Product behavior is sealed in the runtime. Remove only recognized legacy
  // managed package paths; unknown/user packages remain untouched.
  await convergeLegacyProfile();
}

await import("../scripts/mypi.mjs");
