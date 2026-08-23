Prepare a neutral orientation record for an independent advisor. The advisor, not you, makes the recommendation.

Separate what the user actually asked for and what has been directly observed from what the caller agent proposes, assumes, or interprets. Keep failed attempts and their observed outcomes. List open questions and concrete things the advisor could verify. When a claim is backed by an evidence record, cite its ledger ID. Put anything unverified under assumptions or uncertainties. Include only task-relevant, non-secret facts; omit credentials and secrets.

Return only JSON with exactly these keys:
- "objective": one sentence stating the decision or task.
- "userConstraints": exact requirements the user stated.
- "establishedObservations": facts directly observed, with ledger IDs.
- "callerProposal": the caller's tentative approach and reasoning.
- "failedAttempts": attempts made and what happened.
- "unresolvedQuestions": open questions the advisor should weigh.
- "verificationTargets": specific files, commands, or sources worth checking.
- "truncation": true when relevant context did not fit, else false.
