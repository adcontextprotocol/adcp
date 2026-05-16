---
---

Publisher self-service page (`/publisher/{domain}`) gets state-aware UX:

- `/api/registry/publisher` now returns a `hosting: { mode, hosted_url?,
  expected_url }` block — `aao_hosted` when AAO serves the canonical
  document, `self` when the publisher serves it from their own domain,
  `none` when no adagents.json is configured.
- New "adagents.json hosting" panel renders setup instructions per mode
  (CNAME / paste-snippet for self-host; canonical URL for AAO-hosted;
  generate / set-up paths for unconfigured).
- Cold-visitor explainer banner appears only when nothing is registered;
  surfaces "Sign in to claim" or "Claim this domain" depending on auth.
- Empty-agents-with-properties state renders a contextual help callout
  explaining that brand.json (what you publish) and adagents.json (who can
  sell it) are separate documents — addresses Sasha's confusion path.
- Each agent row is now click-to-expand: drill-down fetches the
  `/api/registry/publisher/authorization` endpoint and shows which
  properties that agent is authorized for vs not.
