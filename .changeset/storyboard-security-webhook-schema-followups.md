---
"adcontextprotocol": minor
---

Tighten three universal storyboard false-failure paths: webhook-emission now explicitly requires a configured webhook receiver so unresolved runner URL templates must grade not_applicable instead of reaching the agent; security_baseline positive static-credential probes now document initialized-session dispatch rather than raw direct Bearer-only `tools/call`; and schema-validation now requires the concrete INVALID_REQUEST past-start rejection instead of a trailing branch-set contribution assertion.

Migration note: agents that currently accept a past concrete `start_time` and adjust it to a current/future flight must instead return `INVALID_REQUEST`; use `start_time: "asap"` when the buyer wants immediate activation.
