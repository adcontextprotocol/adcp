---
---

Inject `caller` into every `check_governance` sample_request in the `specialisms/governance-spend-authority` and `specialisms/governance-delivery-monitor` storyboards, matching the shape already landed in `protocols/governance/index.yaml`.

Surfaced by a Matrix v9 wire-tap showing the request payload omitted `caller` even though adcp#2740 had added it to the protocol fixture — the specialisms are authored separately and were missed. Closes the gap referenced in adcp#2763.
