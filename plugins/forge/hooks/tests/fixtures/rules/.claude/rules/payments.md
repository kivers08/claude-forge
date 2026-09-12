---
paths:
  - "src/payments/**"
---

FORGE-RULE-PAYMENTS: every change under src/payments/ needs an idempotency key
test and must not log full card or bank identifiers.
