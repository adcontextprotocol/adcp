---
---

Add Professional+ membership tier gate to content submission (propose_content tool and UI).

Users without `individual_professional`, `company_standard`, `company_icl`, or `company_leader` tier are now blocked from submitting content via the `propose_content` MCP tool and the `/api/content/propose` HTTP endpoint. System users (`system:*` prefix) retain their existing bypass. The My Content dashboard UI now shows a membership upgrade nudge when a submission is rejected for insufficient tier.

Closes #4449.
