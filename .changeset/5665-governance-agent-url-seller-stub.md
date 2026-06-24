---
---

Empty changeset: Default `governance_agent_url` in the `governance_denied` / `governance_denied_recovery` storyboards to a seller-local stub served by the seller's `comply_test_controller`, removing the counterparty-supplied-URL egress/SSRF surface. Alternative to #5665 Option A; depends on runner support for a controller-self-URL placeholder. Addresses #5665 (Option B).
