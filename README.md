# MyPi CLI

MyPi is an agentic coding CLI with a customized,
source-built [Pi](https://github.com/earendil-works/pi) runtime.

The first stable release is **MyPi 1.6.0 (Roma)**. Stable MyPi releases follow
a chronological Roman-city naming series, beginning with Roma.

## Features

- Comprehensive default system prompt with tool-use, autonomy, destructive-action,
  security, and communication guidance. Override it with a `SYSTEM.md` file; a
  packaged minimal replacement is available at
  `docs/system-prompts/minimal.md`.
- `commentary` tool: shares brief user-visible progress, assumptions, partial
  findings, and non-blocking questions without presenting private reasoning
- Hooks: user policy hooks via `hooks.json` (block/observe tool calls, inject
  context, notify on settle) plus agent-registered timer and file-watch hooks
  (`schedule_prompt`, `watch_files`); see `/hooks --help`
- Plan and goal workflows
- Turn-scoped Safe, Sandboxed, approval, and Full Access modes via `/safety`
- Workspace trust preflight plus workspace-confined read/write tools in bounded modes
- Model-aware `/reasoning` control with the existing thinking-level colors
- Native CLIProxyAPI provider support with secure `/login cliproxyapi`, bounded
  model discovery, and session-owned `/fast on|off|status`
- Web search/fetch with Brave search API or curl
- Atomic lifecycle and session leases for daemon-hosted and external control surfaces
- Read-only mode and deprecated safe-mode compatibility
- Chat mode
- Agent-led session archiving and deletion
- Keyword-triggered skill support

## Install

The stable release requires Node.js 22.19 or newer and supports macOS and
glibc Linux on x64 or arm64.

```sh
npm install --global @raririn/mypi
mypi --version
mypi
```

`npm` installs command launchers under the global prefix's `bin` directory.
Some containers configure a user-owned global prefix without adding that
directory to `PATH`. If installation succeeds but the shell reports
`mypi: command not found`, activate the npm global bin directory for the
current shell and try again:

```sh
export PATH="$(npm prefix --global)/bin:$PATH"
hash -r
mypi --version
```

Add the same `export` to the shell profile used by the container if it should
persist. A PATH-independent one-off invocation is also available:

```sh
npm exec --yes --package=@raririn/mypi -- mypi --version
npm exec --yes --package=@raririn/mypi -- mypi
```

MyPi stores its state under `~/.mypi/agent`, or the directory selected by
`MYPI_AGENT_DIR`. Compatible session history and local-state formats are
migrated in place when needed.

## Build and verify

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm verify
```

`pnpm package` writes the publishable npm tarball and its SHA-256 report to
`dist/npm/`. The private root manifest makes `dist/npm/` the sole publish
target.

## Upstream and license

MyPi is MIT-licensed. It includes modified source from the MIT-licensed
[Pi project](https://github.com/earendil-works/pi) and preserves Pi's license
in [`LICENSES/pi-MIT.txt`](LICENSES/pi-MIT.txt). Exact source provenance and
additional acknowledgments are in
[`SOURCE_PROVENANCE.json`](SOURCE_PROVENANCE.json) and
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
