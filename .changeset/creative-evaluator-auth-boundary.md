---
"adcontextprotocol": patch
---

Document the `build_creative.evaluator` authentication boundary: evaluator credentials and caller-supplied trust material stay on the transport/account-provisioning channel, off-list evaluator URLs are rejected before outbound calls, accepted evaluator auth failures degrade to seller-default ranking, and the new evaluator-auth storyboard covers direct `agent_url`, nested `feature_agent`, credential-in-payload, accepted-call, and unavailable-evaluator paths.
