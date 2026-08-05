import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Extension tests run SessionManager and profile helpers in-process. Point
// both MyPi discovery variables (public MYPI_AGENT_DIR and the engine's
// internal MYPI_CODING_AGENT_DIR) at a throwaway profile before any test code
// loads, so a test that forgets its own isolation can never write transcripts
// into the developer's real ~/.mypi/agent. Leaked test sessions surface as
// ghost sessions in every MyPi client (2026-08-05: mypi-tui-auto-title and
// mypi-chat fixtures appeared in the CloudCLI sidebar on production).
//
// Loaded via --import by the test scripts in package.json; the Node test
// runner propagates execArgv to per-file subprocesses, so each test file gets
// its own guarded profile.
const guardDir = mkdtempSync(join(tmpdir(), "mypi-test-agent-"));
process.env.MYPI_AGENT_DIR = guardDir;
process.env.MYPI_CODING_AGENT_DIR = guardDir;
delete process.env.PI_CODING_AGENT_DIR;

process.on("exit", () => {
  try {
    rmSync(guardDir, { recursive: true, force: true });
  } catch {
    // Best effort: a leftover empty temp dir is harmless.
  }
});
