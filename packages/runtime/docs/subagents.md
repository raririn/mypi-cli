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

`consult_advisor` accepts one `question` describing the tentative approach,
assumptions, uncertainty, and decision requested. `ask_for_review` accepts one
`request` describing the completed change, acceptance requirements,
verification, and risks. Both return immediately and deliver their result
automatically through the shared session-owned lifecycle.

`subagent_followup` starts another asynchronous grant over one exact child owned
by the current parent. Completed, failed, timed-out, owner-lost, and cancelled
children can be revived while their parent history still exists.

`subagent_cancel` cancels queued/running grants while retaining revivable
history. `subagent_status` gives an explicit bounded snapshot; ordinary turns
already receive compact live status automatically.

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
