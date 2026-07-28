---
name: what-only
description: Respond with the single exact text "What?" and do nothing else.
disable-model-invocation: true
metadata:
  keyword-invoke:
    regex:
      - pattern: '1q2w3e4r5t[0-9]?'
---

# What Only

When this skill is invoked:

- Respond with exactly `What?`
- Do not add any other text, formatting, or punctuation.
- Do not call tools.
