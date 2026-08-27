# MyPi CLI changelog

## Unreleased

Unified configuration + archive-manage hardening:

- **Unified config.yaml v2 — the single settings authority.** All global
  user-facing settings now live in `~/.mypi/agent/config.yaml`, namespaced
  `shared:` / `cli:` / `gui:`, with deterministic key order and generated
  comments noting when each value takes effect. Clients only load their own
  section plus `shared`. A one-shot migration (CLI startup and daemon boot)
  lifts version-1 files and absorbs settings.json preferences, backing up
  originals under `backups/unified-config/`. `settings.json` is demoted to
  the machine registry (resource lists, changelog stamp, analytics id).
  `safety.defaultMode` and `thinking.defaultLevel` are native config fields;
  the daemon's `update_global_config` handles every field through one path.
  See `packages/runtime/docs/settings.md`.
- **/archive-manage post-incident hardening**: the one-turn tool grant now
  expires loudly ("Session tool grant expired. Run /archive-manage again…");
  the system prompt forbids filesystem fallbacks for session files; listings
  carry machine-readable `details.sessions`/`total`/`hasMore`; and the new
  `delete_archived_sessions_with_max_user_messages` completes the guarded
  bulk path for short test sessions (archive by count, then delete archived
  by count).
- Slash commands that rewrite the prompt (`/archive-manage`, `/goal`,
  `/plan`, `/readonly`, `/chat-manage`, …) tag the dispatched user message
  with the exact typed invocation (`mypiCommandInvocation`), so clients can
  render one command chip instead of echoing both the typed command and the
  rewritten kickoff.
- GUI config gains `gui.thinkingView` ("verbose" | "minimal", default
  minimal) and the `gui.shortcuts.thinkingView` chord (default
  CmdOrCtrl+Shift+V) for the desktop thinking-block folding toggle.

- Code Mode dogfood round 1: `ALL_TOOLS` is now actually defined inside
  cells (was promised by the contract but never injected); goal tools
  (`create_goal`/`get_goal`/`get_goal_plan`) are cell-callable — only
  `commentary`/`deep_thinking`/`ask_user` stay model-direct; tool
  projection moved to config.yaml `tools.mode: flat | code | compatible`
  (compatible = classic schemas AND exec_code, the default; code =
  exec_code only; settings.json remains a dev override) — a daemon restart
  applies changes; a QuickJS load failure now returns actionable guidance
  (restart the daemon or switch tools.mode) instead of a bare stack.
- Model catalog: `reloadPersistedModelState` prunes models-store.json
  entries for providers with no configured credentials (stale ghosts from
  logouts predating the delete-on-logout fix); providers with ambient
  credentials (e.g. ~/.codex OAuth) are kept.
- Fixed BUG-115: the durable-inbox delivery test now polls for the
  persisted state instead of racing the unref'd persistence timer —
  test:product is fully green in parallel runs.

- **Code Mode (FEAT-087)**: a programmable tool runtime. The model can call
  the new `exec_code` tool with raw JavaScript that runs in a hermetic
  QuickJS-WASM isolate (no fs/net/console/imports; 30s default timeout,
  memory/stack caps) where every session tool is available as
  `await tools.<name>(args)`. Nested calls run the exact model-path pipeline
  (validation/coercion, safety ladder, /readonly, hooks, subagent leases)
  and emit `tool_execution_*` events tagged `callSource:"code_mode"` +
  `parentToolCallId`; their results persist as bounded
  `mypi-code-mode-call` transcript audit entries and never enter model
  context — only `text()` output returns. `Promise.all` over tools runs
  host-side concurrently; `parallel([...])` adds per-tool execution-mode
  batching; `store()`/`load()` persist across cells. `settings.json
  tools.mode: flat | code | code-only` (dev default `code`; `code-only`
  collapses the visible tool list to `exec_code` + communication tools and
  embeds compact TS declarations — ≥60% smaller than JSON schemas —
  rendered under hard byte budgets with degrade-to-`unknown`). Verified
  end-to-end against gpt-5.3-codex-spark, gpt-5.6-luna and
  deepseek-v4-flash (cliproxyapi): single-cell multi-file workflows produce
  exact curated output with full nested audit.

- Honest user-agent option: new `honestUserAgent` global config field (off by
  default). When on, model requests advertise `pizzeria/<version>` instead of
  any compatibility user-agent — applied in the request header transform
  (sdk.ts), read from config.yaml with a short TTL so a toggle takes effect
  on running engines within seconds. The app's own non-model HTTP user-agent
  (`getPiUserAgent`) is renamed from `pi/…` to `pizzeria/…`.
- Provider auth over the daemon wire (GUI /login parity, engine-free):
  `list_auth_providers` enumerates every provider and its auth state;
  `provider_login` runs one flow with an async-start ack, then streams the
  provider's own prompts (`auth_prompt`, incl. secret/select/manual-code and
  a retract signal) and notices (`auth_notice`, incl. auth_url/device_code)
  to the client, answered via `answer_auth_prompt` and ended by `auth_done`;
  `cancel_provider_login` and client disconnect abort cleanly;
  `provider_logout` is confirm-gated. Credentials land in the shared
  auth.json that live engines re-read on their next model listing. New
  runtime exports: `listDaemonAuthProviders`, `runDaemonProviderLogin`,
  `daemonProviderLogout`.
- Sessions announce persisted message entries: after `message_end` (which
  intentionally precedes persistence and so cannot carry an id), the engine
  emits `entry_appended` with the stored entry — GUI clients use it as the
  live fork handle instead of reloading history. The TUI→GUI bridge
  forwards it too.
- Auto-title reads what the user actually typed: the session-start backfill
  prefers a skill invocation's `originalText` and unwraps `<objective>`
  command templates (e.g. /goal), so goal sessions no longer all title from
  the shared planning-template preamble.
- GUI config schema gains `gui.favouritePi` (additive): the desktop brand
  decoration preference — "rotate" (default) or a catalog slug the GUI
  owns; the daemon validates the slug shape only, so new decorations never
  need a daemon release.
- GUI config schema gains configurable Home (`gui.shortcuts.home`,
  CmdOrCtrl+Shift+H) and New session (`gui.shortcuts.newSession`,
  CmdOrCtrl+N) shortcuts (additive keys, validated like the rest).

- Engine-free archive cleanup over the daemon wire (additive, protocol
  stays 2): `preview_archive_cleanup` reports the excess beyond
  `history.maxArchived` for a project and `execute_archive_cleanup`
  permanently deletes it (confirm-gated), broadcasting `persisted_changed`
  removals so clients refresh.
- /archive-manage learns orphaned-session hygiene: `list_session_archives`
  gains an `orphaned_only` filter (sessions whose recorded project folder no
  longer exists) and the new `delete_orphaned_session` tool permanently
  removes one such session — active or archived — refusing whenever the
  folder still exists. Default GUI workbench width raised to 576px.

## 2.0.0-beta.10 — 2026-08-25

- Model-callable agent hooks return with the reviewed greedy one-trigger
  lifecycle and typed internal-message delivery (the beta.4 re-entry bar):
  `schedule_wakeup` replaces `schedule_prompt` with a single per-session
  wakeup slot (scheduling again replaces it, firing consumes it, delay floor
  raised to 60s), and `watch_files` watches are one-shot (first change fires
  and consumes the watch; cap 3). Firings deliver as `mypi-hook-fired`
  custom messages that state they are not user input — never a steer, never
  a fabricated user message. While a run is active, firings coalesce and
  deliver at settlement through continuation arbitration; after an aborted
  or failed run they wait in context without starting a turn; when idle
  they start a turn immediately. Both tools' descriptions forbid polling
  subagent/goal/plan state, which arrives automatically at run boundaries.
  The TUI renders fired hooks as a "⏰ Hook fired" row showing only the
  firing lines, so an automated wakeup never reads as user input.
- The daemon config service now exposes the host-global default safety mode
  (settings.json `safety.defaultMode`, the value newly created sessions
  capture): `get_global_config` replies gain an additive
  `config.safety.defaultMode`, and `update_global_config` accepts field
  `"safety.defaultMode"`, routed to the settings store (validated against
  the safety ladder, persisted before the reply). Protocol stays 2.

Transcript write hygiene and compaction (session-daemon protocol stays 2;
all additions are backward compatible):

- `appendEntry` gains a declared entry nature: `kind: "snapshot"` marks
  last-writer-wins state. The engine — not the feature — skips appends whose
  significant content is unchanged (`volatileKeys` are ignored when
  comparing) and throttles pure churn to one snapshot per 30 s
  (`minIntervalMs`), bounding crash-recovery staleness. Snapshot entries
  carry `snapshot: true` in the transcript. A log-only flood guard flags any
  custom type writing at bloat-producing rates (>60 entries or >512 KB per
  minute). Policy lives in `core/extensions/append-policy.ts`.
- The Goal v3 state adopts the snapshot policy. Previously every mutation
  appended a full state copy: one measured session carried 9,770 snapshots —
  65 MB of an 88 MB transcript — where restore only ever reads the last one.
- Transcript compaction: `planSessionCompaction` keeps every message, event,
  and unparseable tail verbatim and drops only snapshots shadowed by a
  deeper same-type snapshot on every branch path through them, reparenting
  surviving children so all branch chains resolve. `compactPersistedSession`
  applies it under the stored-session writer lock (live sessions are
  refused), verifies the rewrite by full reparse before an atomic replace,
  and reports removed-entry and byte metrics. The measured 88 MB session
  compacts to 25.7 MB with zero broken chains.
- New daemon request `compact_session` (`sessionId`, `confirm: true`);
  refuses live sessions independently and broadcasts `persisted_changed` on
  change. `/archive-manage` gains a `compact_session_history` tool with the
  suite's writer-state discipline, and archiving a session now compacts it
  best-effort inside the same lock before the move.
- MCP tool-result image parts are capped (~3 MB decoded) the same way MCP
  text always was; oversized images become an explanatory text marker. User
  image inputs were already bounded by `packages/ai` validation.

## 2.0.0-beta.9 — 2026-08-24

- Aligns the MyPi CLI/daemon release version with the Pizzeria desktop
  candidate at `2.0.0-beta.9` without changing session-daemon protocol 2,
  Roma chronicle 1, or Pi core `0.82.1`.
- Pizzeria records this version as descriptive release-qualification metadata;
  protocol and capability negotiation, not SemVer equality, remain the runtime
  compatibility authority.

## 2.0.0-beta.8 — 2026-08-24

- Extends validated `gui.shortcuts` to the complete application keymap while
  retaining atomic cross-client config authority and live desktop rebinding.
- Adds trusted resource-file reads that accept only exact current discovery
  inventory paths, regular non-symlink files, and a 2 MiB UTF-8 preview bound.
- Extracts MCP wizard services over the existing probe, tokenizer/name
  suggestion, config parser/redactor, atomic persistence, and MCP manager.
- Adds sanitized engine-free daemon operations for MCP list/probe/save,
  enable/disable, live catalog test, and confirmed removal. Secrets remain
  environment references and raw MCP records never cross the client boundary.
- Adds confirmed in-app global-config repair without requiring a CLI command;
  protocol generation remains 2.

## 2.0.0-beta.7 — 2026-08-24

- Keeps exact protocol 2 and adds engine-free sanitized global-configuration
  read, update, and GUI-migration services for desktop Settings.
- Extends version-1 `config.yaml` with validated `gui:` preferences for product
  mode, theme/preset, layout widths, command-palette shortcut, and remote host
  records. Unknown keys and raw MCP configuration survive unrelated changes.
- Serializes same-process config mutations and locks the exact config target,
  preventing collisions with unrelated profile locks while preserving atomic
  cross-client writes and fail-closed unsafe/malformed behavior.
- Sanitized responses omit raw MCP values and expose only bounded server IDs;
  update fields are runtime-allowlisted to prevent arbitrary path mutation.

## 2.0.0-beta.6 — 2026-08-24

- Completes the beta.5 daemon/catalog correction as one exact CLI/GUI pair;
  beta.5 is retained as development evidence and is not a release candidate.
- Keeps exact session-daemon protocol 2. The daemon remains authoritative for
  archive, command inventory, model catalog, workspace tracking, and rewind;
  the GUI now consumes those services with fail-closed slash-command routing
  and catalog-validated history-model restoration.
- Carries the beta.5 global `config.yaml.defaultModel` authority, engine-free
  command discovery and checkpoint listing, accurate mutation estimates,
  durable continuation settlement, and rewind behavior into the qualified
  beta.6 package without a protocol-generation change.

## 2.0.0-beta.5 — 2026-08-24

- Keeps exact session-daemon protocol 2 and requires deployment to purge the
  unreleased stale beta.1 daemon before launching this pair. Fresh-session
  draft correlation remains the beta.4+ attach identity contract.
- Restricted tracker-unavailable and historical change estimates to successful
  calls from known file-mutation tools. Read, preview, search, image, and other
  tools with a `path` argument no longer fabricate mutations such as
  `AGENTS.md`, `.` directories, or temporary screenshots.
- Added engine-free, cwd-scoped slash-command inventory for extensions, prompt
  templates, and skills. Draft and idle-session GUIs can discover the complete
  resource command set before the first prompt.
- Made checkpoint listing an unattached daemon service. Opening Rewind no
  longer resumes the full session engine; engine startup is deferred until a
  checkpoint is selected for preview.
- Model catalog service now returns the exact runtime-resolved default model so
  a fresh GUI task can make the selection explicit; a genuinely unavailable
  default remains null and the GUI denies fresh sends.
- Rewind preparation identifies a checkpoint before the first user prompt so
  GUI and TUI can warn that the task/history focus will be removed. The preview
  remains a single aggregate diff from a fresh current-workspace capture to the
  requested snapshot, with unique net paths.

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
- Explicit Goal delegation counts are hard new-child caps. Corrections reuse a
  consumed child's follow-up or stay in the parent; they cannot add replacement
  children beyond an objective such as one explore plus three work agents.
  The first unchanged status poll now yields immediately to automatic result
  delivery instead of spending three provider calls per wait phase.
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
