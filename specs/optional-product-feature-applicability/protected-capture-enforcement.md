# Protected capture enforcement: SDK 15.9.5 audit and proposed placement

Status: **proposal only**, supplementing [the collection prerequisite](collection-prerequisite.md). No SDK/DSL/runtime/dependency change is implemented or
authorized. SDK ownership is **unconfirmed**; the stable reviewer is not an
implementation owner, and the archived former owner has no replacement recorded in the preserved ownership records.
Route this plan through root before assigning work. This supplements #8259 and
does not remove its human/WG/CODEOWNERS gates or the reporting draft's holds.

## Audit basis and the enforcement point

Audited the installed `@adcp/sdk` **15.9.5** CJS implementation and declarations. The repository already applies its creative-build-probe postinstall bridge; this plan does not add or alter it. The pristine published package comparison is separately scoped in [the pin comparison](sdk-pin-comparison.md).
The line anchors below refer to `node_modules/@adcp/sdk/dist/lib/.../*.js`, not
unavailable TypeScript source line numbers. Proposed source targets use the
corresponding upstream `src/lib/.../*.ts` paths. No source maps/source tree are
shipped in this local package. Its CJS and ESM builds must receive the same fix.

**Add a central internal write policy in proposed new source
`src/lib/testing/storyboard/protected-context.ts`.** Proposed helper names below
are **absent today**:

```ts
// Contract sketch, not executable implementation or an existing SDK API.
applyProtectedContextPatch(store, { set, unset }, internalWriter)
```

The helper is the sole commit point for context values, deletions, provenance
and unavailable-output metadata for a run using the new fixture contract.
`internalWriter` is a runner-owned capability, never a caller-supplied string,
`source_kind`, serialized provenance entry, or boolean permission flag.
It validates the whole patch before changing any map: a forbidden write/delete
fails visibly and leaves values and metadata unchanged. Authoring collisions
fail before discovery; runtime collisions fail before dependent side effects,
not as `fixture_unsatisfied` or a successful optional skip.

Reserve a flat capture prefix in the **proposed opt-in contract**, for example
`__adcp_fixture_`, and the exact declaration-produced keys beneath it. This
fits existing whole-key `$context.<key>` substitution; it does not require
nested-token syntax. Reject reserved keys supplied by storyboard defaults,
initial/routed caller context, step `context_outputs` (including generators and
task-completion captures), conventional extractors or another preparation
namespace. Validate key syntax and reject prototype-sensitive keys. Ordinary
legacy context/override behavior outside this opt-in reservation remains intact.

Keep the authoritative captures/witnesses in a separate runner-owned immutable
prepared-state store. A proposed context-store factory applies initial defaults
and caller patches through the same helper; declaration-local selected-entity
captures are committed once, with the preparation capability, only after the
**whole** fixture graph resolves. Do not use `context_provenance` as permission:
the standalone API already accepts that diagnostic map from its caller.

## Exact current funnels that must use the policy

All `runner.js` anchors map to upstream
`src/lib/testing/storyboard/runner.ts`; `context.js` anchors map to
`src/lib/testing/storyboard/context.ts`.

| Existing function / installed anchor | Required proposed integration |
| --- | --- |
| `loader.js:validateStoryboardShape` (`:87`), `validateContextOutputs` (`:344`); `fixture-resolution.js:validateFixtureResolutionDeclarations` (`:146`) | Compile the proposed reserved-key policy while validating declarations; reject collisions across fixture captures, initial defaults, step outputs/generators and creative prefixes before execution. The write helper still enforces runtime inputs independently. |
| `executeStoryboardPass`, `runner.js:1631` | Replace initial `{...storyboard.context, ...options.context}` with the context-store factory; register reserved declarations before either input is applied. |
| `runMultiPass`, `runner.js:2967`, `3047–3052` | Apply the same initial merge policy to pre-seed context. Carry the verified prepared store into every `executeStoryboardPass`, not just private `preSeeded.result` bindings. Validate each resolved route/instance scope before reusing state; incompatible scope cannot reuse another instance's evidence. |
| `runStoryboardStepBody`, `runner.js:3245`, `3367–3387` | Same factory/policy before any step; hydrate protected state only from verified preparation, not `options.context`, `context_provenance`, contributions or unavailable-output maps. Preserve it in the standalone execution state. |
| `executeStoryboardPass` creative preparation, `runner.js:2082–2084`; `runStoryboardStepBody`, `3345–3347` | Route prefix-key deletion and `resolution.context` insertion through the helper. Validate creative-prefix/capture collisions at load. A creative preparation result is not permission to write fixture captures. |
| `executeStep`, `runner.js:4492–4511` | `extractContextWithProvenance` produces a patch; its `clearGroups` deletions, convention `Object.assign`, provenance updates and removal of unavailable markers commit atomically through the helper. `source_kind !== convention` is not an immutable-namespace check. |
| `executeStep`, `runner.js:4513–4539` | `resolveTaskCompletionOutputs`/`remapTaskCompletionOutputs` and `applyContextOutputsWithProvenance` produce explicit/generated patches; replace `Object.assign` and associated metadata mutations with the same guarded commit. Validate reserved generator keys before populating the alias cache. Keep existing ordinary-capture success/failure semantics outside the new namespace. |
| `executeStep`, `runner.js:4261–4263`; full `recordUnavailableOutputs`, `1842–1848`; standalone maps, `3367–3370` | A skip or caller-supplied unavailable/provenance map must not erase protected provenance or mark a prepared capture unavailable to suppress its consumer. Reserve/check metadata keys as well as values. |
| Phase/step clones, `runner.js:2394`, `4488–4489`; successful/skipped result adoption, `2715`, `2740` | Use a proposed store-aware fork/adoption operation preserving the out-of-band policy and prepared-state identity. A shallow spread/result context must never drop write protection or become a new source of authority. |
| `buildExecutionState`, `runner.js:2196–2212`; standalone state, `3372–3387`; `executeStep` default, `3526–3536` | Carry one typed protected/prepared-state reference in every execution path, including preflight temporary states. Do not put its authority in public JSON context or the free-form `runnerVars.runState` map. |
| `buildRoutedStoryboardRun`, `compliance/comply.js:1073` | Its route/run-context spread is another caller-input merge. Route it through initial policy validation or pass distinct untrusted inputs to the runner factory; never import protected captures from route JSON. |

`seeding.ts`'s existing `runDeclaredFixtureResolution`/`selectDiscoveredFixture`
is the proposed selected-snapshot producer. Today it binds identities only;
it has **no** generic selected-capture context commit. Add its successful
all-or-nothing publication through the helper after graph completion, preserving
the product/scoped-price/witness association and terminal resolution failure.

## Seller context and reference aliases: two different boundaries

There is **no current arbitrary `taskResult.data.context` → StoryboardContext
merge** in the audited runner. Seller data is promoted only by fixed task
extractors (`context.js:101` account extraction, `:128` products, etc.) or authored
`context_outputs` paths. A seller-returned `context` bag can be explicitly
captured with such a path; that write must use the explicit-output funnel above.
Do not add a new implicit merge. `core/AgentClient.js:retainSession` (`:265`)
retains transport `metadata.contextId`/pending task identity; it does not hydrate
fixture capture authority from a seller's opaque protocol context.

**Guarding map assignments alone is insufficient.** `context.js:deepReplace`
(`:422`) returns `context[key]` by reference; `applyContextInputs` (`:562`) also
injects the context object without cloning its value. Output capture helpers
(`:472`, `:511`) likewise select seller object references. The current public
`injectContext` API demonstrably lets a request object's mutation alter the
original context object. Authoritative selected snapshots must therefore be
deep-cloned on ingestion, deeply immutable privately, and returned as detached
request/diagnostic views. Cover `injectContext`/`deepReplace`,
`applyContextInputs`, request-builder reads, result/preview context, and custom
assertion callbacks' result objects. Use own-key lookup and safe object maps.
Trusted arbitrary JavaScript plugins remain trusted process code, not a sandbox;
the boundary protects caller/seller JSON and accidental reference mutation.

`buildStepRequest` (`runner.js:3461–3511`) accepts `options.request`, applies
context inputs/enrichment and `applyBrandInvariant`;
`applyFixtureBindingsSafely` (`:5106`) and `buildEffectiveStepRequest` (`:5136`)
then bind/expand requests. These are consumers, not context write permission.
The proposed prepared-state consumer must check final **effective** route,
credential identity, account/sandbox, and declared bound-entity fields before
dispatch (all normal/raw/A2A/parallel dispatch branches begin at `:3955–4097`).
Apply the same check in `buildEffectiveStepRequest`'s preflight path. Bind prepared-state reuse to the exact immutable schema artifact/bundle identity (or verified content digest) and contract version; a mutable `latest` URL or version label alone is insufficient. Distinguish
authored positive/negative selector witnesses; do not forbid an intentional
negative selector or silently repair a conflicting request override. Existing
SDK brand enrichment can change authored brand: trusted caller branding is a
separate qualification check, never derived from captured seller metadata.

Probe/webhook/validation-only branches return the input context unchanged in
15.9.5; they do not have a hidden generic capture commit. Their returned views
and downstream adoption still need the same immutable prepared-state handling.
`forwardAliasCache` maintains generator aliases, not capture authorization.

Prepared-state parity does not imply conditional phase-flow parity: public standalone execution also ignores enclosing `phase.skip_if`. [The sort probes](format-sort-authorability.md) reproduce this with legal zero/one-row data. Qualify conditional standalone execution separately; the protected-write helper does not fix phase orchestration.

## Separate security-critical hosted state-reference boundary

An SDK-local protected-write policy is **not** hosted authorization. Proposed
hosted prepared-state resolution needs a separately reviewed mandatory operation,
for example `resolveAuthorizedPreparedState` (**absent today**):

1. Authenticate on **every reference lookup/step**, not just preparation or
   reference creation. Resolve the principal/tenant/org/run from trusted server
   session state; check the current run/account/seller grant, revocation,
   expiry, resolved route/URL, storyboard content, schema/AdCP target and contract version before
   disclosing a snapshot or performing a dependent call. Recheck effective
   per-step credential scope after routing/auth overrides. An opaque reference
   or successful decryption alone never grants access.
2. Bind using nonsecret principal/grant identifiers and grant/credential
   generation. Never serialize bearer/OAuth tokens, keys or credential objects
   into capture evidence. A revoked/incompatible reference fails terminally;
   it must not trigger a new discovery, account switch or automatic rebind that
   hides prior failure. Grant checking must be enforced again at the seller.
3. Store prepared state server-side under that scope and accept an opaque
   reference, or use an explicitly reviewed authenticated reconstruction.
   Browser JSON `context`, `request`, provenance, contributions, signed/encrypted
   prior context and seller-returned values cannot independently establish
   verified prepared state. Bound snapshot size/lifetime and diagnostic output;
   preserve account-scoped confidentiality of pricing and catalog metadata.

Existing adoption points (not implementation assignments):
`server/src/routes/registry-api.ts` step route currently forwards ordinary JSON
context (`:10183–10203`); `server/src/addie/mcp/member-tools.ts` uses
`storeStoryboardContextRef`/`resolveStoryboardInputContext` (`:918`, `:946`) with
sealed metadata/expiry checks and calls `runStoryboardStep` (`:6049`);
`server/src/conformance/run-storyboard-via-ws.ts` builds a full-run wrapper
(`:107–114`). These mechanisms do **not** constitute the proposed prepared-state
grant/revocation contract. Do not reuse Addie's sealed context as evidence of
fixture verification, or claim that its metadata matching alone supplies the
new every-lookup grant check.

## Required acceptance evidence before implementation approval

- Full, multi-pass, standalone, routed MCP/A2A and hosted steps reject caller,
  authored/default, explicit/generated/task-completion and convention attempts
  to replace/delete protected keys; values and provenance stay unchanged.
- Seller opaque context is not implicitly merged; explicit capture into the
  reserved namespace is rejected. Request/input/result/callback view mutations
  cannot alter prepared snapshots. No protected value is exported before all
  fixtures resolve. Ordinary old context semantics remain unchanged.
- Tampered/fake refs, cross-user/org/run/account/route/target reuse, expired and
  revoked grants fail **on every lookup** without snapshot leakage or wire
  calls. Include a grant revoked after a successful prior step and an auth
  override/reroute after preparation; knowing a valid opaque ref is insufficient.
- Standalone retries retain the selected graph and terminal outcome. Unknown
  runner contracts fail closed. Namespace enforcement and grant lookup are
  independently tested; neither substitutes for the other.

Durable read-only evidence is in
[context-write-boundaries.test.cjs](context-write-boundaries.test.cjs) (**3/3 tests pass**).
Public `injectContext` returns the original whole-object reference;
`extractContext` does not implicitly merge a seller opaque context bag; real
public `runStoryboardStep` can explicitly capture `context.seller_value` into
the proposed reserved prefix today. The last probe uses only read tools and a
fully intercepted public MCP transport. Schema acceptance does not assert that
an adversarial change to an opaque request echo is protocol-valid. These tests
preserve existing behavior; they implement no new API or runtime protection.
