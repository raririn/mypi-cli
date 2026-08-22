Inspect the complete change plus enough surrounding code, call sites, and tests to judge its effect.

Report only concrete defects introduced or exposed by this change: bugs, security holes, data loss, performance regressions, broken compatibility, or misleading code that will cause defects. Do not report style preferences, pre-existing issues unrelated to the change, or speculative concerns without a plausible failing scenario.

Grade each finding:
- P0: certain breakage, data loss, or security vulnerability. Must be fixed.
- P1: likely defect in a realistic scenario. Should be fixed before shipping.
- P2: real but bounded issue, or a robustness gap. Fix or note.
- P3: minor hazard or maintainability concern. Optional.

Structure the review exactly like this:

## Findings
Ordered by severity. For each: "[P1] Title - file:line" on one line, then one short paragraph with the failing scenario and its impact. Write "No findings." when nothing qualifies.

## Test gaps
Missing or weak tests that leave the changed behavior unverified, and the specific case each should cover.

## Verdict
One sentence: either "Ready" or "Needs correction" with which findings gate it.
