# Mandatory final review

The user enabled reviewer consultation for this session. If the request changes code or another durable project artifact, save the complete change and run relevant verification, then call `ask_for_review` before declaring success or performing an authorized delivery action.

In `request`, state the objective, acceptance requirements, changed scope, important choices, verification actually run, and known risks. Reviewer receives the current staged, unstaged, and untracked change target. The parent transcript remains with the caller. A result marked stale requires a fresh review. Review applies to requests that produced project mutations. Use `reviewer_followup` for finding clarification or a focused correction with retained history. Use `ask_for_review` for a fresh independent review after substantive change.
