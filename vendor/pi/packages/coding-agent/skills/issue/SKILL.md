---
name: issue
description: Apply the MyPi issue intake, pickup, implementation, verification, and closure workflow.
disable-model-invocation: true
metadata:
  keyword-invoke:
    priority: 100
    case-sensitive: false
    keywords:
      - '[ISSUE]'
    regex:
      - pattern: '(?=[\s\S]*\b(?:issues?|bugs?|defects?|regressions?|feature requests?)\b)(?=[\s\S]*\b(?:track(?:s|ed|ing)?|record(?:s|ed|ing)?|log(?:s|ged|ging)?|fil(?:e|es|ed|ing)|report(?:s|ed|ing)?|triag(?:e|es|ed|ing))\b)'
        flags: i
---

# MyPi Issue Workflow

Apply this workflow to the user's original request. Treat `[ISSUE]` as an activation marker only; do not copy it into issue titles, descriptions, commands, or user-facing prose unless needed to explain activation. Natural-language tracking intent remains part of the original request.

## Establish scope

1. Locate the repository root and read its `AGENTS.md` plus any more-specific instructions for files you may change.
2. Read `ISSUES.md` before acting. Read the linked `PLAN.md` items and relevant documentation rather than relying on tracker summaries alone.
3. Inspect `git status --short` and preserve all unrelated tracked and untracked work. Never reset, clean, stash, force, or overwrite another task's changes.
4. Infer whether the user wants intake, pickup/implementation, a status update, closure, or a combination. Ask only when the requested outcome or safety boundary is genuinely ambiguous.
5. If the request includes pull, push, publish, receiving-host, or cross-host synchronization, read `SYNC.md` completely and use its guarded workflow.

## Intake or update

1. Search `ISSUES.md`, `PLAN.md`, and relevant docs for an existing report before creating one. Update or cross-link a duplicate instead of opening a parallel item.
2. Preserve concrete observations, exact errors, reproduction evidence, and suspected dependencies. Label a cause as suspected until code or test evidence confirms it. Do not modify supplied session/history evidence unless the user asks and it is safe.
3. Choose the next unique identifier for the appropriate type. Re-scan the tracker immediately before editing so concurrent additions cannot reuse an ID.
4. Assign priority by repository policy:
   - **P0:** data loss, corruption, or security boundary failure.
   - **P1:** broken primary workflow.
   - **P2:** release or quality gate.
   - **P3:** maintenance or product decision.
5. Use the tracker structure: status/report date, observed or requested behavior, testable acceptance criteria, verification, and dependencies/details. Keep it concise and actionable.
6. Add or update the corresponding ordered `PLAN.md` item with files, acceptance, dependencies, and executable verification. Update architecture docs and `docs/07-decisions-and-roadmap.md` when an accepted decision, architecture boundary, roadmap, or open product question changes.
7. Intake/status-only edits may proceed in a dirty tree only after reviewing relevant diffs and confirming the targeted blocks do not contain unrelated unresolved work. Make narrow edits and report the pre-existing dirty state.

## Development pickup

1. Before implementation, run `./scripts/sync-host.sh status`. Start only from a clean, current tree as required by `ISSUES.md`; if that cannot be established, report the blocker and do not discard or hide local work.
2. Select the highest-priority unblocked item unless the user explicitly chose another. Mark its status `in progress` and record the owner before implementation.
3. Reproduce the defect or establish a failing focused test. Protect user data and use isolated fixtures instead of mutating real sessions, credentials, or host state.
4. Implement the smallest complete fix while preserving stated safety boundaries. Prompt wording alone must not replace application or extension enforcement.
5. Add the regression coverage named by the issue. Prefer the authoritative runtime surface and real Electron coverage when desktop behavior is involved.
6. Run focused checks first, then every broader lane required by the issue, `PLAN.md`, and affected docs. Record exact commands and outcomes.

## Completion or blocking

- Mark an item complete only when all acceptance criteria and required verification pass.
- Synchronize its checkbox/status and evidence across `ISSUES.md`, `PLAN.md`, and linked docs. Record accepted decisions and remaining open questions in `docs/07-decisions-and-roadmap.md` when applicable.
- If blocked or partially verified, leave it open, state the blocker and completed evidence, and keep unchecked work explicit.
- Run `git diff --check` and review the final targeted diff for accidental edits, secrets, credentials, session content, generated artifacts, duplicate IDs, and stale cross-references.
- Commit or publish only when requested or required by the pickup protocol, and then follow `SYNC.md`. Never claim tests passed unless they were run.

## Report

Concisely report:

- issue identifier and resulting status;
- tracker, plan, docs, code, and tests changed;
- verification actually run and its result;
- suspected versus confirmed cause;
- blockers, unverified lanes, or unrelated pre-existing work left untouched.
