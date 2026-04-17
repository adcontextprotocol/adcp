---
---

feat: Add semantic governance extensions — Semantic Alignment Attestation, Decision Trace Protocol, and Ontology Capability Declaration.

Three new extension schemas for governance transparency:
- `ext.semantic_alignment`: Documents how buyer terms were resolved to seller concepts with confidence scores and alignment chains
- `ext.decision_trace`: Captures candidate evaluation, scoring, selection rationale, and rejection reasons at each decision point
- `ext.semantic_capabilities`: Allows sellers to declare supported taxonomies and alignment methods in get_adcp_capabilities

These extensions use the existing ext.* mechanism and are designed for graduated promotion to core protocol fields. They support regulatory compliance (EU DSA Article 26, EU AI Act Article 50, CA SB 942) and enable governance agents to validate semantic resolution quality.

New documentation: docs/governance/semantic-transparency.mdx
