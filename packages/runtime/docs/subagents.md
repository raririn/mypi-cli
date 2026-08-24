# Asynchronous subagents

MyPi can delegate bounded work to child MyPi sessions without copying their
intermediate context into the parent. The parent `AgentSession` owns each child
RPC process, its inspectable JSONL history, cancellation, live status, and
completion delivery.

## Roles

- `explore`: parallel read-only repository or public-web investigation.
- `work`: sequential workspace mutation. Every work child is sandboxed and
  holds the workspace write lease, so the parent cannot edit, write, or run
  Bash until the child settles or is cancelled.
- `advisor`: read-only advice about a supplied plan or decision.
- `review`: read-only review of supplied final code or changes, with a bounded
  current Git snapshot when available.

Advisor and reviewer use separate first-class tool calls and packaged prompts.
Their Markdown resources are intentionally modular so policy wording can be
tuned without changing lifecycle or enforcement. Child prompts describe
positive role, authority, evidence, and output; hard restrictions remain
code-owned.

## Tools

`subagent_start` accepts one homogeneous batch of one to eight `explore` or
`work` jobs and returns opaque program-generated child/grant IDs immediately.
Mixed roles are rejected before admission. Results arrive automatically.
When an active Goal objective explicitly states an exact explore/work child
count (for example, "delegate 1 explore agent and 3 work subagents"), that
count is a code-enforced new-child cap for the Goal lineage. A correction must
reuse the consumed child's history through its follow-up or be completed by the
parent; it cannot silently expand the requested delegation topology.

`consult_advisor` accepts one `question` describing the tentative approach,
assumptions, uncertainty, and decision requested. `ask_for_review` accepts one
`request` describing the completed change, acceptance requirements,
verification, and risks. Both return immediately and deliver their result
automatically through the shared session-owned lifecycle. One advisor and one
reviewer may be active at a time. When a current conversation exists, the first
fresh admission returns a packaged confirmation prompt. Repeating the exact
same question/request within the same user epoch and two-minute window confirms
replacement; a changed objective starts a new confirmation. A running
conversation is cancelled and settled before confirmed replacement starts.

`subagent_followup` creates a new grant continuing an exact explore/work child.
`advisor_followup` continues the most recent advisor; `reviewer_followup`
continues the most recent reviewer. These tools never retrieve output. They
reject while the child is active or its previous result is unconsumed, then
start another asynchronous grant over retained role and history.
Starting a fresh advisor or reviewer after settlement makes that conversation
the target of future role-specific follow-ups. Older histories stay available
for manual inspection while model tools address the current conversation only.

`subagent_cancel` cancels queued/running grants while retaining revivable
history. `subagent_status` gives an explicit bounded snapshot; ordinary turns
already receive compact live status automatically. A status check while the
same children remain active ends the parent tool loop immediately so automatic
delivery, rather than polling, owns the next run.

## Storage and context

Children are stored under:

```text
$MYPI_AGENT_DIR/subagents/by-parent/<parent-session-id>/
```

Each child has structured metadata and an ordinary `session.jsonl` suitable for
manual inspection or a future contained client. Child transcripts are not
normal Tasks and are never implicitly inserted into the parent. The parent sees
only tool admission/status and a bounded final completion message. IDs are
cryptographically random capabilities and cannot be chosen by either model.

## Lifecycle

- Last-client detach immediately cancels every child of that parent.
- Interrupting the parent turn cancels all jobs with an explicit revivable
  reason.
- A dead daemon owner is recorded as owner loss on resume; no job restarts.
- Live parent writer leases prevent managed archive/delete. Archive/restore
  retains child storage; permanent delete removes it.
- Results are delivered only at safe provider-turn boundaries and can wake one
  still-attached idle parent turn.
- Goal and subagents are sealed built-in session participants. Child lifecycle
  events remain private to the manager; only the parent session arbiter may
  start a result-review turn.

When a child settles during an active parent run, its result stays in the
session-owned result inbox. It is not added to Pi's steer/follow-up queues. The
next provider context projects the typed result directly; a successful parent
assistant message acknowledges it, persists the same typed internal notice,
and broadcasts that notice without starting another turn. If no parent provider
run is active, the settlement arbiter orders user guidance first, delegated
results before Goal continuation, and then starts at most one parent run.
`agent_settled.continuationPending` therefore describes the decision before the
following `agent_start`. An active Goal cannot complete until its owned child
work is settled and delivered results have been accepted into context.

Terminal grants written by this runtime persist `pending|delivered` inbox state
in the child manifest. Resume replays a pending result only when the current
parent branch does not already contain its accepted typed result message.
Historical grants without inbox state are treated as delivered, so an upgrade
does not replay old consultations or work reports.

## Advisor model

`/advisor-model` opens a model picker for new advisor and reviewer children.
The default `inherit` uses the parent model. An explicit selection is stored in
the global MyPi YAML. Existing children and follow-ups retain their pinned
model. An unavailable explicit advisor model fails rather than silently falling
back.

Advisor first asks the caller model for a neutral no-tools briefing over the
effective parent context. The configured advisor model receives only that
brief, the caller hypothesis, a bounded exact evidence ledger exposed through
`advisor_evidence`, workspace read/search, and sealed public web research. It
does not receive parent assistant history. Advice is marked stale after new user
context and marked arrived-after-mutation when the parent changes the workspace
before advice completes.

## Mandatory usage guidance

Both policies default off:

```yaml
subagents:
  advisorModel: inherit
  requireAdvisor: false
  requireReviewer: false
```

Use `/advisor [on|off]` and `/reviewer [on|off]`. A change updates this session
and the global default for new sessions; other live sessions retain their own
state. Off removes mandatory usage guidance while `consult_advisor` and
`ask_for_review` remain callable.

## Project review policy

A trusted canonical project may provide `.mypi/REVIEW.md`. A safe non-empty
regular UTF-8 file no larger than 32 KiB replaces the lean built-in reviewer
rubric. The sealed read-only envelope and every tool/policy boundary remain.
Unsafe present policy fails review admission. Reviewer evidence covers staged,
unstaged, and untracked changes and completion is marked stale when the target
changes during review.

## Model selection persistence

`/model` changes only the current session. To also update the global model
preset, use either accepted form:

```text
/model --global provider/model
/model provider/model --global
```
