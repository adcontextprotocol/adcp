# createAdcpServer framework migration — plan and blockers

Status: not started in production code. This document captures the concrete
blockers and the staged plan that should drive a dedicated migration PR.

## Why migrate

The training agent currently uses a hand-rolled MCP dispatch in
`task-handlers.ts` (~3,300 lines). `@adcp/client` 5.3 ships `createAdcpServer`
which provides:

- **Native idempotency integration.** `config.idempotency` accepts the
  `IdempotencyStore` we already instantiate; the framework handles
  `check()` / `save()` / `release()` around every mutating tool.
  Eliminates the dispatch-level claim/save state machine in task-handlers.ts.
- **`ctx.emitWebhook` on handler context.** `config.webhooks = { signerKey }`
  populates a bound emitter; handlers call `ctx.emitWebhook(...)` without
  plumbing the emitter through closures.
- **Auto-wired RFC 9421 verifier.** `config.signedRequests = { jwks, ... }`
  mounts `preTransport`; the current `request-signing.ts` Express middleware
  becomes redundant.
- **`get_adcp_capabilities` auto-generation** from the registered domain
  handlers — keeps the capability block truthful as tools are added/removed.
- **Framework-level `context` echo** on every response (success + error).
- **50%+ LOC reduction** in the core dispatch.

## Blockers that require design decisions before a clean migration

### 1. Response shape: framework `wrap` vs our envelopes

Framework's per-tool `wrap` functions (`mediaBuyResponse`, `updateMediaBuyResponse`, etc.) expect handler return values shaped like the AdCP response DATA (e.g. `{ media_buy_id, status, packages }`). Our handlers already return that shape — so we should be able to remove our hand-rolled envelope wrapping and let the framework do it.

**But** `update_media_buy` and any tool that returns `{errors: [...]}` as a well-formed body (the ERROR_IN_BODY pattern) conflicts with the framework's wrap — it would stamp `content: "Media buy undefined updated"` because `data.media_buy_id` is absent. Options:

a) Detect the errors-body case in each handler and return a pre-formatted `McpToolResponse` (framework's `isFormattedResponse` check passes through). This is the safest path.
b) Refactor error-in-body tools to use `adcpError` envelope, breaking the current `ERROR_IN_BODY_TOOLS` contract. Requires a separate spec check.

Recommended: (a) — wrap only the error-body path per-handler.

### 2. Type issues in `server.tool()` for custom (non-AdcpToolMap) tools

For tools outside `AdcpToolMap` (`creative_approval`, `update_rights`, `comply_test_controller`, `validate_property_delivery`, the five collection-list endpoints), registration goes through `McpServer.tool(name, description, zodSchema, handler)`. The `handler` return type is a strict MCP tool response shape that requires `structuredContent: Record<string, unknown>` (not `| undefined`). Our `toMcpResponse` adapter emits `structuredContent` always for success, but never for errors — needs a branch.

Also: the framework's `McpServer` comes from the SDK's CJS build while our imports resolve to ESM. These two declarations are structurally identical but TypeScript treats them as distinct (private `_serverInfo` field). The McpServer we return from `createFrameworkTrainingAgentServer` has CJS type; callers using ESM import fail to assign. Fix: either use `as McpServer` cast at the boundary or force the import resolution via `tsconfig` path mapping.

### 3. VERSION_UNSUPPORTED enforcement

Legacy dispatch rejects unsupported `adcp_major_version` at the request layer (`task-handlers.ts:~3177`). Framework doesn't read this field. Either:
- Validate in a `preTransport` hook (runs before MCP dispatch)
- Validate in each handler adapter
- Accept that unsupported major versions fall through to per-tool Zod validation

Recommended: preTransport hook (one place, doesn't duplicate per handler).

### 4. `dry_run` short-circuit on task-augmented requests

Legacy dispatch skips task augmentation when `dry_run === true` (`task-handlers.ts:~3196`). The framework's task-capable server flow doesn't know about `dry_run`. Handlers need to short-circuit themselves OR we add a preTransport that rewrites the `task` field to undefined when `dry_run` is set.

### 5. Stateless-HTTP task store workaround

Legacy code uses the RAW task store (not `extra.taskStore`) to avoid `notifications/tasks/status` failing in stateless mode. The framework uses `createTaskCapableServer` which may or may not hit this problem. Needs empirical verification — spin up the framework server, send a task-augmented `create_media_buy`, watch for "fresh transport" failures in logs.

### 6. `resolveIdempotencyPrincipal` threading

The framework's hook receives `(ctx, params, toolName)`. Our `scopedPrincipal(auth, accountScope)` composition needs `accountScope` derived from `params` — easy. But the framework invokes this *before* the handler; the legacy path derived it inline. Verify that `params` at that point is the full un-stripped request (including `account.account_id`).

### 7. AsyncLocalStorage session cache

`runWithSessionContext` / `flushDirtySessions` (in `state.ts`) wrap each HTTP request to give handlers a request-scoped session cache. This is independent of the framework — it lives in the Express route in `index.ts`. The route already does:

```ts
return runWithSessionContext(async () => {
  const { result, flushable } = await dispatchCallTool(request, extra);
  if (flushable) await flushDirtySessions();
  return result;
});
```

Under the framework, the Express route would instead call `transport.handleRequest(...)` and let the framework dispatch. The `runWithSessionContext` wrap still works — it wraps the whole transport call. `flushDirtySessions` needs to run after the framework returns but before the response closes. Doable but needs careful placement.

### 8. Test harness

`simulateCallTool(server, name, args)` in unit tests reaches into `(server as any)._requestHandlers.get('tools/call')` directly. `createAdcpServer` returns `McpServer` which wraps the low-level `Server` at `.server._requestHandlers`. Every test file using this pattern needs updating:

- `server/tests/unit/training-agent.test.ts` (600+ tests)
- `server/tests/unit/account-handlers.test.ts`
- `server/tests/unit/comply-test-controller.test.ts`
- `server/tests/unit/collection-lists-storyboard.test.ts`

Mechanical change but 4 files, high line count.

### 9. `TrainingContext` vs `HandlerContext`

Framework's `HandlerContext` is `{ account, sessionKey, store, authInfo, emitWebhook }`. Our handlers take `TrainingContext` = `{ mode, principal, userId?, moduleId?, trackId?, learnerLevel? }`. A trivial adapter:

```ts
const trainingCtx: TrainingContext = {
  mode: 'open',
  principal: ctx.authInfo?.clientId ?? 'anonymous',
};
```

The `mode`/`userId`/`moduleId`/`trackId`/`learnerLevel` fields are only populated in the Addie-embedded path (`executeTrainingAgentTool` in-process usage), not in the MCP route. Keep `executeTrainingAgentTool` unchanged.

### 10. Custom capabilities block

Our `handleGetAdcpCapabilities` returns a bespoke shape with `publisher_domains`, `compliance_testing.scenarios[]`, `request_signing`, etc. The framework auto-generates capabilities from registered tools — useful, but doesn't know about the training-agent-specific fields.

Resolution: override `get_adcp_capabilities` via `server.tool(...)` after `createAdcpServer` returns. Our override wins (McpServer's `.tool()` replaces prior registrations). Straightforward once the `server.tool()` typing issues are resolved (blocker #2).

## Recommended staged plan

1. **PR 1 — infrastructure prep (low risk).**
   - [x] Export `getWebhookSigningKey()` from `webhooks.ts` (already done).
   - [ ] Update `simulateCallTool` helper in every test file to traverse both `server._requestHandlers` (legacy) and `server.server._requestHandlers` (McpServer).
   - [ ] Add a feature flag `TRAINING_AGENT_USE_FRAMEWORK` (default off) in `index.ts`.

2. **PR 2 — scaffold framework server (behind flag).**
   - [ ] Add `framework-server.ts` with `createFrameworkTrainingAgentServer(ctx)`.
   - [ ] Resolve type issues in blocker #2 (McpToolResponse nullability, CJS/ESM assignment).
   - [ ] Wire every domain handler through an `adapt()` helper that produces `McpToolResponse` directly (bypasses framework `wrap`, preserves byte-level response shape).
   - [ ] Register 9 custom tools (non-AdcpToolMap) via `server.tool(...)`.
   - [ ] Flag routes `index.ts` to the framework server when set.
   - [ ] Run the storyboard suite under both paths; diff response shapes for any tool where the framework shape differs.

3. **PR 3 — resolve edge cases (behind flag).**
   - [ ] VERSION_UNSUPPORTED preTransport.
   - [ ] dry_run short-circuit.
   - [ ] Stateless-HTTP task-store verification; use raw store if framework behavior differs.
   - [ ] Context echo parity check (framework's `injectContextIntoResponse` vs our manual).

4. **PR 4 — flip default + delete legacy.**
   - [ ] `TRAINING_AGENT_USE_FRAMEWORK=1` becomes default.
   - [ ] Remove legacy dispatch wrapper, `HANDLER_MAP`, `TOOLS` array from `task-handlers.ts`.
   - [ ] Delete `request-signing.ts` (framework's `signedRequests` config replaces it).
   - [ ] Confirm storyboard pass count unchanged or improved.

## Estimated scope

~2-3 days of focused work across 4 PRs. Single-session full migration is not
realistic without shipping something fragile — the type-system issues alone
took half a session to diagnose.
