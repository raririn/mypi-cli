# MyPi CLI changelog

## 2.0.0-beta.4 — 2026-08-24

- Temporarily removed the model-callable `schedule_prompt` and `watch_files`
  tools after beta.3 dogfood demonstrated that repeated timer steering could
  prevent Goal/subagent settlement and exhaust context. User `hooks.json`
  policy hooks and the user-only `/hooks` command remain active. Agent hooks
  will return only with a separately reviewed greedy one-trigger lifecycle and
  typed internal-message delivery.
- Added durable program-owned `run_boundary` entries. They record the exact
  outcome and continuation-pending decision for every parent run without
  entering model context; the daemon keeps tracking and busy state open until
  the terminal boundary.
- Active parents now consume ready subagent results directly in the next
  provider context. Successful acceptance persists and broadcasts a sealed
  typed internal notice without creating user input, steering/follow-up queue
  state, or another provider run.
- Result consumption is grant-idempotent. Continuation/follow-up tools reject
  active children and unconsumed results, explicitly state that they create new
  work rather than retrieve output, and terminate repeated unchanged status
  polling cleanly. Paused Goal-owned results persist without waking a run.
- Tightened Goal planning toward the smallest deliverable-oriented plan:
  implementation and verification stay together, bookkeeping artifacts and
  final-response items are forbidden unless requested, optional toolchains do
  not become requirements, and routine inspection/delegation cannot grow into
  separate phases.
- Rewind is now one daemon transaction. Preparation returns typed blockers;
  explicit force consent aborts blocking runs and subagents; execution restores
  the workspace, forks before the selected user message, removes that checkpoint
  inclusively, clears all session change sets, and returns the replacement
  session identity. Workspace materialization rolls back if transcript forking
  fails. Hosted `/rewind` uses the same blocker and consent service.
- Fresh attach accepts a client draft correlation ID and echoes it only to the
  creating surface, removing refresh/attach ordering from draft promotion.

## 2.0.0-beta.3 — 2026-08-23

This exact protocol-2 CLI/GUI pair fixes Goal/subagent continuation ordering
and completes rewind transcript isolation without changing the public protocol.

### Built-in session continuation ownership

- Promoted Goal and subagents from ordinary product-extension continuation
  behavior to sealed `session` product modules. Only this non-forgeable class
  receives the privileged continuation request API.
- Added session-level settlement arbitration. Subagent evidence outranks a
  competing Goal continuation, ordinary extension messages are serialized at
  the same boundary, `agent_settled.continuationPending` is emitted before the
  selected next `agent_start`, and at most one parent run begins.
- Kept child `agent_start` events private to child RPC sessions. Only the parent
  result-review run appears in the parent lifecycle.
- Moved completed subagent results out of Pi's active intra-run `followUp`
  queue. Results wait for a true idle/settled boundary, publish active and
  unconsumed counts atomically, and block Goal completion until consumed or
  cancelled.
- Persisted `pending|delivered` result-inbox state per new terminal grant.
  Restart replays only unconsumed results and reconciles a result already
  accepted on the current parent branch; historical unmarked grants do not
  replay.
- Kept daemon and TUI GUI-control settlement/busy projection aligned for
  pending continuations.

### Rewind isolation

- After a successful TUI rewind, best-effort branch forking truncates the
  transcript immediately before the checkpoint's user message so subsequent
  inference cannot see abandoned post-checkpoint conversation history.

### Verification

- Product 208/208, host 13/13 (including real RPC subagents 6/6), daemon 39/39,
  hosted 13/13, RPC dialogs 2/2, preattach 5/5, and distribution 6/6.
- Focused core settlement/registry/safety 24/24, typecheck, build, public-tree,
  package, and diff checks pass.

## 2.0.0-beta.2 — 2026-08-23

This protocol-2 stabilization build must be paired with the 2.x desktop GUI.
It does not change the exact-match daemon protocol; it completes the project,
tracking, service-tier, and startup behavior shipped for dogfood after beta.1.

### Project lifecycle and tracking

- Project archive/delete now closes every idle engine attached only by the
  requesting client before history maintenance. Active turns and any other
  attached client remain hard blockers, with a complete preflight before any
  attachment is changed.
- Project removal no longer requires the former workspace directory to exist:
  tracker storage is removed by its stable project identity without reopening
  a work tree, and missing descendants canonicalize through their nearest
  existing ancestor so macOS `/var` aliases cannot strand trust decisions.
- Persisted-session listings now report whether the recorded working directory
  still exists, allowing clients to explain stale temporary-project history.
- The TUI settle footer is intentionally minimal: one separator followed by
  `X files changed.` Detailed review remains in the Changes-capable client.

### Provider-neutral service tier

- Removed the provider-specific `/fast` command and its branch-local
  `mypi-cliproxy-fast` state.
- Added `serviceTier: default|priority` to the version-1 global
  `$MYPI_AGENT_DIR/config.yaml` contract. `/settings` owns the control;
  `/thinking` remains the separate reasoning-level control and thinking level
  was removed from `/settings`.
- CLIProxyAPI consumes the generic tier only at turn boundaries and only for a
  model advertising `supportsPriorityServiceTier`; unsupported models and
  in-flight requests remain unchanged.

### Startup feedback and discovery naming

- Interactive launches paint `Starting MyPi...` immediately, then
  `Connecting...`, `Loading session...`, and `Rendering interface...` while
  the existing runtime work proceeds.
- Added a bounded `startup-timings.jsonl` profile log carrying launcher,
  module-graph, daemon/preattach, runtime/session, extension-factory, shell,
  and fully-ready-interface deltas. This is observability/feedback; the larger
  module-graph optimization remains a separate task.
- Added clear `metadataProtocol: 1` to `mypi __remote-info`; retained
  `protocol: 1` as the compatibility alias while bridge/workspace stay 2.

### Verification

- Full CLI gate: 206 product, 13 host, 39 daemon, 13 hosted, 2 RPC-dialog,
  5 preattach, and 6 distribution tests, plus coordinated build/typecheck,
  public-tree and runtime-customization verification.
- PTY startup probe observed every staged label and a complete timing record
  ending at `main-interface-first-frame` (1.448 s in the warm embedded sample).

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
