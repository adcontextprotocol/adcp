---
---

feat(registry): document `POST /api/organizations` and auto-bootstrap profile on first agent registration

Strategic follow-up to the `POST /api/me/member-profile` REST bootstrap branch landed in `aao-member-profile-bootstrap-impl.md`. That change made the spec implementable but didn't address the actual storefront-bootstrap question: **what's the minimum-friction path for a third-party app holding only a user's OAuth token to land a registered agent?**

Previously, that flow required *three* round trips:

```
POST /api/organizations         (undocumented; cookie-session look)
POST /api/me/member-profile     (404'd from the agent-register cliff)
POST /api/me/agents             (404 if the profile didn't exist)
```

— and the middle endpoint had no documented public REST contract until #4130. This change collapses it to *two* round trips by making the second one automatic:

```
POST /api/organizations         (now publicly documented)
POST /api/me/agents             (auto-creates the member profile on first call)
```

### Changes

- **`POST /api/me/agents` auto-bootstraps the member profile** when the caller's organization doesn't have one yet. Reuses the existing `ensureMemberProfileExists` helper (the same one Addie's `save_agent` tool uses), so the slug-collision and private-by-default invariants stay consistent across surfaces. The response includes `profile_auto_created: true` on the bootstrap path so callers can render a "we set up your profile" hint without needing to detect the prior 404 → bootstrap → retry shape.

- **`POST /api/organizations` is now documented in the public OpenAPI spec** under a new `Onboarding` tag. The endpoint has been in production for a long time but only existed as a private surface exercised by the AAO dashboard's `/onboarding` form. Surfacing it in the spec — with the *real* enum values, not the fabricated ones the previous spec PR shipped — is the minimum-surface answer to the storefront-bootstrap question.

- **OpenAPI spec regenerated** from the canonical Zod registrations. Schemas live in `server/src/schemas/onboarding-openapi.ts` and the existing `server/src/schemas/member-agents-openapi.ts`; the YAML at `static/openapi/registry.yaml` is the build output.

### Why not delete the previous `POST /api/me/member-profile` REST bootstrap?

It still has utility for callers that want to set `display_name`, `slug`, brand identity, or company metadata *before* registering any agents (rather than accepting the org-name-derived defaults). The new agent-side auto-bootstrap is the recommended path for storefront-style integrations; the explicit profile-create endpoint stays as the customization escape hatch.

### Coverage

- New integration test `server/tests/integration/member-agents-auto-bootstrap.test.ts` covering: first-call auto-create, subsequent calls don't re-trigger the warning, idempotent agent-update path, and PATCH does not auto-bootstrap (a missing profile on update is a genuine error, not a "first time" case).
