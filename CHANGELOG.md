# MyPi CLI changelog

## 2.0.0-beta.1 — 2026-08-23

This is a breaking daemon/control-protocol release. MyPi CLI/daemon 2.x and
the 2.x desktop GUI must be upgraded together. Protocol-1 clients receive a
typed handshake rejection; the daemon does not guess, downgrade, or expose a
partially compatible service surface.

### Protocol and packaging

- Advanced the exact-match MyPi session-daemon protocol from 1 to 2.
- Advanced the authenticated TUI/GUI control and remote-helper bridge protocol
  from 1 to 2 so ownership/handoff metadata cannot falsely advertise old-client
  compatibility.
- Advanced `@raririn/mypi`, source provenance, package provenance, version
  output, and bridge protocol metadata to `2.0.0-beta.1`.
- Retained Roma release identity/chronicle 1 and Pi core `0.82.1`; this release
  changes MyPi product protocol, not the pinned upstream runtime.
- Added explicit daemon and typed-client regressions proving protocol-1 peers
  are rejected with both protocol numbers in the diagnostic.

### Goal model-facing interface

- Removed Goal identity and lifecycle revision from model-facing `get_goal`,
  `get_goal_plan`, and `update_goal_plan` text/schema.
- `update_goal_plan` now accepts bounded stable-item operations while the
  controller binds the active Goal and latest authoritative plan internally.
- Added atomic protected-scope revalidation, no-op rejection, and a
  three-repeated-rejection/no-progress circuit breaker that pauses instead of
  wasting automatic continuation turns.
- Rewrote advisor/reviewer prompt constraints affirmatively and updated the
  runtime customization guard and prompt regression.

### Workspace tracking, change sets, and rewind

- Added exact-root tracking consent beside inherited project trust, with a
  versioned trust-store migration and daemon-owned authority.
- Added bounded workspace estimates and warnings at 10,000 eligible files,
  1 GiB apparent size, broad roots, or truncated estimation.
- Added private text-only checkpoints for explicit user messages; steering and
  hidden/automatic continuations are excluded.
- Added sensitive-directory/credential exclusions, symlink safety, and opaque
  presence-only handling for binary, oversized, unreadable, and linked paths.
- Added configurable per-session retention (3 live/1 detached defaults), with
  pruning only at checkpoint/detach lifecycle boundaries.
- Added exact net change sets with stored patches/counts and one shaped
  estimated fallback for untracked, disabled, missing, corrupt, and historical
  sessions.
- Added concurrent same-workspace intersection metadata without serializing
  collaborative sessions or leaking another task's prompt.
- Added tracker health warnings, confirmed rebuild, checkpoint listing,
  two-stage rewind, active-peer blocking, affected-task confirmation, and
  requester-only later-checkpoint removal.
- Added previewed project archive/delete operations that clear trust/tracking
  decisions and tracker state while preserving workspace files.

### Archive lifecycle

- Added daemon `set_session_archived` authority for coding and Chat histories.
- Archiving an idle sole-client session now closes its engine before moving
  history; active turns and other attached clients hard-block the operation.
- Every successful archive destroys all checkpoint state/refs owned by the
  session across project trackers, expires reflogs, and prunes unreachable
  snapshot objects.
- Materialized settled change sets remain available for archived Diff; restore
  does not recreate destroyed rewind checkpoints.
- Applied the same snapshot-destruction rule to automatic maintenance and
  `/archive-manage` single/bulk archives.

### Hosted clients and interactive UI delivery

- Added typed hosted workspace actions for tracking consent, change sets,
  checkpoints, and rewind.
- Buffered respondable extension-UI frames that arrive in the same socket chunk
  immediately after `attached`, preventing late TUI joiners from losing a
  parked `ask_user` request before their permanent listener binds.
- Strengthened hosted-test cleanup to await engine exit and retry transient
  `ENOTEMPTY` removal races.

### CLIProxyAPI reasoning replay

- Preserved signed reasoning and reconstructed unsigned non-empty reasoning for
  opted-in Codex-compatible thinking gateways.
- Added explicit empty reasoning replay for every same-model assistant step
  that emitted text/tool calls with zero reasoning tokens, fixing
  `cliproxyapi/deepseek-v4-flash` failures requiring `reasoning_content` on the
  next request.
- Kept first-party OpenAI, unflagged providers, and cross-model transcripts
  unchanged.
- Live-qualified the exact create/compile/run/edit/recompile sequence, including
  the formerly failing tool-only `reasoning: 0` step.

### Test and fixture depth

- Expanded the fake RPC engine to emit realistic user/assistant `message_start`,
  thinking/text updates, completed `message_end`, tool events/results,
  `turn_end`, persistence, ask-user responses, and settlement order.
- Updated host fan-out assertions for multiple ordered assistant updates.
- Final post-version-bump functional gate: 207 product, 13 host, 38 daemon,
  13 hosted, 2 RPC-dialog, 5 preattach, and 6 distribution tests, plus build,
  typecheck, public-tree, package, runtime-customization, and distribution
  verification.
- Packaged artifact identity is `raririn-mypi-2.0.0-beta.1.tgz`; the publishable
  package includes this changelog.
