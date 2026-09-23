---
"adcontextprotocol": patch
---

Fix webhook-emission compliance setup to discover and bind a real product and
pricing option before create_media_buy, waiting for asynchronous discovery to
complete when needed. Replace unresolved test-kit schema
references with explicit request and response schema paths and complete the
trigger samples so conformance validation cannot silently skip these requests.
