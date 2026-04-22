---
---

fix(member-agents): surface OAuth challenge instead of raw SDK error

When a member-agent requires OAuth authorization, the storyboard runner on
`/dashboard/agents` rendered the SDK's `NeedsAuthorizationError` message
verbatim ("Provide an OAuthFlowHandler or run an interactive flow to complete
authorization.") with no way to act on it. The `/applicable-storyboards`,
`/storyboard/:id/step/:stepId`, `/storyboard/:id/run`, and
`/storyboard/:id/compare` endpoints now detect the SDK's OAuth-required
signal (either `NeedsAuthorizationError` message text or
`ComplianceResult.overall_status === 'auth_required'`), lazily ensure an
`agent_context` exists, and return `{ needs_oauth: true, agent_context_id }`.
The dashboard renders a "Connect via OAuth" panel whose authorize button
reuses the existing `/api/oauth/agent/start` flow.
