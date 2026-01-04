---
"adcontextprotocol": minor
---

Add Property Governance Protocol for AdCP 3.0

Introduces stateful property list management for governance agents:

- Property list CRUD operations with filters and brand manifests
- Feature discovery via `list_property_features`
- Discriminated unions for base property sources (`selection_type` discriminator)
- Identifiers-only responses (scores stay internal to governance agents)
- Webhook notifications for list changes
