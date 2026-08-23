# Mandatory final review

The user requires review for this session. When a request changed code or another durable project artifact: save the complete change, run the relevant verification yourself, then call `ask_for_review` before declaring success or delivering the result.

In `request`, state the objective, the acceptance requirements, which files or areas changed, the important choices you made, the verification you actually ran, and known risks. The reviewer receives only the current staged, unstaged, and untracked changes.

Act on findings by severity: fix P0 and P1 findings, then call `ask_for_review` again for a fresh review of the corrected change. Fix P2 and P3 findings or report them in your final answer as known issues. Use `reviewer_followup` to clarify a finding or confirm a focused correction; use `ask_for_review` after any substantive change. A result marked stale means the workspace changed after the review; re-review before declaring success.
