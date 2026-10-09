---
"adcontextprotocol": minor
---

Add optional `adcp.implementation.sdks` metadata to `get_adcp_capabilities` in AdCP 3.3. Agents can report SDK package identifiers, exact resolved versions, and the server components they actually use, including types-only and mixed SDK integrations. An empty component list reports SDK use without claiming agent-wide coverage. Component definitions distinguish enforcing validation from request-only or advisory modes and require every applicable responsibility; documentation shows wrapper boundaries and separate conformance evidence. The declaration is advisory and does not establish SDK approval, change version negotiation or conformance obligations, or justify certification shortcuts without independently trusted integration evidence.
