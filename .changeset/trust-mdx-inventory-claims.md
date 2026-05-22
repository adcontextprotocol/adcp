---
---

docs(trust): add Inventory and product claims paragraph to the Identity surface in trust.mdx. Names what the existing brand.json ↔ adagents.json ↔ RFC 9421 chain lets a buyer verify about a `get_products` response (who is authorized to sell), and explicitly bounds what it does not (catalog accuracy, delivery-time inventory truth). Points to billing reconciliation (#2391) and adagents.json revocation as the downstream truth and remediation mechanisms. Closes #2392 with a C2PA "claim-not-certification" posture rather than a new schema field.
