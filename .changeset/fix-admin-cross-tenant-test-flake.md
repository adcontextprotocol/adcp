---
---

Empty changeset: server test-infra cleanup only. Auth middleware background
cleanup timers no longer keep Vitest workers alive, and the flaky admin
cross-tenant unit test now bootstraps its WorkOS env before importing auth.
