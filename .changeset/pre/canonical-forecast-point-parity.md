---
"adcontextprotocol": minor
---

Restore the normative constraints `canonical-forecast-point` dropped from its source twin: the `maximum: 1` bounds on `viewable_rate` and `metrics.coverage_rate` ranges, and the `anyOf` requiring `standard` whenever any viewability value is present. A shared forecast-rate range keeps generated SDK types unambiguous, while a parity contract test compares the twins' resolved viewability schemas and exceptional metric constraints so canonical-pair drift fails CI instead of shipping silently.
