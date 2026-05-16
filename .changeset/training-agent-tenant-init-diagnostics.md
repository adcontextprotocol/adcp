---
---

fix(training-agent): surface tenant registry init failures + boot-phase timing

Wraps `await holder.get()` in `tenantMcpHandler` with a `try/catch` that
logs the rejection (message, name, stack, cause) and returns a JSON-RPC
503 instead of letting the unhandled rejection escape to Express's
default error handler — which produced an HTML 500 with no JSON body
and no log entry tying the error to the rejected promise. The
post-deploy smoke had been catching the symptom for several deploys
without enough context to identify the cause.

Also adds boot-phase timing in `createRegistryHolder` so each phase is
visible: registry construction, per-tenant config build, per-tenant
register elapsed, and aggregate totals. Init takes ~14ms locally; the
new logs let us see which phase is blowing up the budget on a fresh
Fly machine. Per-tenant register failures are logged with stack before
re-throwing so a single bad tenant doesn't hide behind `Promise.all`.
