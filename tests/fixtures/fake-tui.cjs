#!/usr/bin/env node
// Exec seam target for `mypi attach --take` tests: stands in for the native
// TUI launch and just echoes the argv it was handed.
console.log(`FAKE_TUI ${process.argv.slice(2).join(' ')}`);
