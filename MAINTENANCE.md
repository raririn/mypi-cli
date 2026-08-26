# Maintenance — mypi-cli

MyPi CLI, runtime, and session daemon (a sealed fork of the Pi coding agent).
`origin` = `pizzeria/mypi-cli` on forgejo; `github` is a manual mirror.
Toolchain: Node ≥ 22.19, pnpm 11.17. Tags use the `cli/v` prefix.

## Where things live

| Path | What |
|---|---|
| `packages/runtime/src/core/` | Engine: agent-session, settings, extensions, safety, compaction, daemon services. |
| `packages/runtime/src/product/` | Sealed MyPi product modules (hooks, plan/goal, safety, global-config, subagents, chat). |
| `packages/runtime/src/modes/` | `rpc/` (daemon protocol) and `interactive/` (TUI, incl. `components/`). |
| `packages/{ai,agent,tui}/` | Vendored Pi layers: provider/SDK, agent harness, TUI primitives. |
| `scripts/mypi-daemon.mjs` | Session daemon (frame router; wire-doc header). |
| `scripts/build-*.mjs`, `verify-*.mjs` | Build, npm-package, and verification tooling. |
| `tests/*.test.mjs` | Integration lanes (daemon, host, rpc, agent-hooks, distribution). |
| `packages/runtime/test/product/*.mts` | Product-module unit tests (`node --test`). |

## Sync

```bash
git pull --ff-only && pnpm install
```

Upstream Pi changes are imported only here, reviewed against
`PI_UPSTREAM_PROVENANCE.json`.

## Version update

Bump these together (keep them identical), then rebuild so `dist/` matches:

- `package.json` `version`
- `SOURCE_PROVENANCE.json` `version`
- `scripts/verify-public-tree.mjs` (asserted version string)
- `tests/distribution.test.mjs` (`productVersion` + `displayVersion`)
- `CHANGELOG.md` — turn `## Unreleased` into the dated version heading

```bash
pnpm build && pnpm test:distribution   # confirms the contract lines agree
git commit -am "release: advance MyPi to <version>" && git tag cli/v<version>
```

## Publish

```bash
pnpm verify          # verify:public + build + typecheck + test + package + verify:runtime + verify:distribution
git push origin main --tags
```

Full-suite note: `pnpm test` (node lanes) is the release gate. The
`packages/runtime` vitest lane has some pre-existing failures and is not part of
`pnpm test`. npm publish is `pnpm package` (produces the `@raririn/mypi` tarball);
GitHub mirror push is manual and optional.
