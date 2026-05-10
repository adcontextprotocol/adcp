---
---

Server: `createProspect` no longer transfers `organization_domains` ownership on a domain conflict. After #4159 Stage 2, that row drives brand identity, so a stray `ON CONFLICT DO UPDATE` could silently move the brand-primary across orgs. Closes the medium finding from #4321.
