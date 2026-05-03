---
"adcontextprotocol": minor
---

spec(specialisms): add `sponsored-intelligence` to `AdCPSpecialism` (preview)

Adds `sponsored-intelligence` to the `AdCPSpecialism` enum so SI agents have a wire-level specialism ID to claim, with the same dispatch parity as `signal-marketplace`, `creative-template`, `governance-spend-authority`, and the other agent shapes. SDKs (e.g. `@adcp/sdk` v6) can now key SI dispatch off the specialism ID instead of routing through escape-hatch handler bags.

Shipped as `status: preview` while the four SI lifecycle tools (`si_get_offering`, `si_initiate_session`, `si_send_message`, `si_terminate_session`) remain `x-status: experimental`. Per the preview-status contract, claims of this specialism are graded as `{ status: "preview", passed: null, reason: "storyboard not yet defined" }`; conformance for SI agents continues to be exercised by the `sponsored-intelligence` protocol baseline at `/compliance/{version}/protocols/sponsored-intelligence/`. Promotes to `stable` (with `required_tools` and a graded storyboard) when the SI tools graduate.

Closes #3961.
