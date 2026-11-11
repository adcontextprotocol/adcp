# Stable core, digest-pinned extensions, modular SDK

This directory holds a runnable example for the modular Ad Context Protocol (AdCP) proposal
(`docs/reference/proposals/modular-adcp.mdx`). It shows declared extensions end to end. In this
document, a *hook* is a place where a module lets extensions attach: an extension point, an open
union, or the kernel's `task` union. The example shows the following properties:

- **The kernel gets a mechanism, not a list of extension points.** The kernel (`core`) defines
  the envelope `ExtensionEntry` `{ uri, digest, must_understand?, data }`, the branch ID
  `<uri>#<branch>`, two hook annotations (`x-adcp-extension-point` for extension points,
  `x-adcp-open-union` for open discriminated unions), the negotiation fields, and one hook of its
  own besides the capability fragment: the `task` union, through which an extension adds a task
  (a Model Context Protocol (MCP) tool or Agent2Agent (A2A) skill). Each module declares its own hooks on
  its own schemas. Under the final layout, buying's layers own the four module hooks the
  examples use: pricing owns the `pricing_option` extension point and the `pricing_model` union,
  commitment owns the `commercial_terms` extension point, and execution owns the `media_buy_state`
  readback extension point. No core schema references an extension. See
  [Hooks and pricing models](#hooks-and-pricing-models) and [Final layout](#final-layout).
- **An extension is a small package.** It has a manifest, a JSON Schema that references
  core types by URI through `$ref`, a normative spec (`spec.md`) with an ID per rule, and
  conformance storyboards. It also has the code that "understands" it (`index.mjs`), generated
  types, and a digest over its JSON Canonicalization Scheme (JCS) bytes; the digest also pins the
  spec, the storyboards, and the code. See [Where an extension's rules live](#where-an-extensions-rules-live).
  The examples include the following packages. The first two are working group (WG) examples
  ported from real pull requests (PRs), and the third is a vendor example:
  - `rate-card-index`, from #7955, reworked as an ignorable explanation of a core quote.
  - `seller-adjustable-terms`, from #8102 with a `kind` discriminator.
  - `@acmetv/adcp-ext-daypart-codes`, a vendor namespace.
  - `linear-tv-indexed-cpp`, a **pricing model** that core doesn't have, registered as a branch
    of the `pricing_model` open union.
- **Each app generates its own typed layer: the generated binding.** The app lists its extensions in
  `adcp.config.json` and runs `npm run sdk`, which writes `adcp-sdk/` next to the app. Extension data
  is a plain attribute at the hook the core declares: the buyer reads
  `proposal.commercial_terms.makegood_units.rules[0].max_units`, and the seller writes
  `terms.makegood_units = { rules }`. A contributed task is a typed client method,
  `client.requestMakegood(request)`, and a typed handler, `server.handle('request_makegood', handler)`.
  The wire stays the extension envelope. `@adcp/core` has no dependencies, and adding an extension
  never touches it. See [Developer journey](#developer-journey) and [Generated binding](#generated-binding).
- **Buyers fail closed.** A buyer rejects a message that carries a must-understand
  extension it doesn't understand, a digest mismatch, or divergent digests. It
  ignores unknown optional extensions. An unknown pricing branch in a product's list of
  options drops only that option, with a warning; signed terms that carry one still fail
  closed. The owning module sets this per union (`unknown_in_list`).

The core schemas are **real**: 446 files copied byte for byte from adcp `main`
(`4f811d253e`; schema sources are identical to `ab9587c11f`, `45591e97b3`, and `80fe5b2c08`).
`core/placement.json` assigns each file to a layer with the final layout: the kernel `core`,
`kernel-types`, the standard modules, each of buying's eight layers, and the generated `_assembly`.
See [Final layout](#final-layout). One file, [`core/patches.json`](core/patches.json), lists the
proposed core change, grouped by the layer that owns each changed file.
After this change, core is **frozen per layer**: `core/release.json` pins a digest per layer and for
the whole bundle, and the build fails if any layer moves.

The **creator scenario** is a proposal-based creator buy where the seller slips a video and
issues a make-good. It uses two extensions added after the freeze: `seller-adjustable-terms`
(version 1.6.0) and `makegood-units` (version 1.5.0). The buyer asks for the make-good itself,
through the `request_makegood` task that `makegood-units` contributes. The flow is `request_proposals` -> `refine_proposals` finalize ->
`accept_proposal`; see [The proposal flow](#the-proposal-flow). The scenario also covers the following:
- The compatibility language: one digest across core 3.3 and 3.4, refused on 4.0 with reasons.
- The path from `adcp.config.json` to the software development kit (SDK).
- A typed buyer app. See [Creator scenario](#creator-scenario-frozen-core-sdk-assembly-compatibility).

## Contents

- [Run the example](#run-the-example)
- [Developer journey](#developer-journey)
- [Generated binding](#generated-binding)
- [Contributed tasks](#contributed-tasks)
- [Where an extension's rules live](#where-an-extensions-rules-live)
- [Final layout](#final-layout)
- [Module versions: a minor release and the modules map](#module-versions-a-minor-release-and-the-modules-map)
- [The proposal flow](#the-proposal-flow)
- [Size, like for like](#size-like-for-like)
- [Slide excerpts](#slide-excerpts)
- [Architecture](#architecture)
- [Directory tree](#directory-tree)
- [Output](#output)
- [Design issues found](#design-issues-found)
- [What changes in AdCP and in each SDK](#what-changes-in-adcp-and-in-each-sdk)
- [Python layout](#python-layout)
- [Hooks and pricing models](#hooks-and-pricing-models)
- [Revenue-share pricing is not a package here](#revenue-share-pricing-is-not-a-package-here)
- [Promotion path: rate-card-index into core](#promotion-path-rate-card-index-into-core)
- [Creator scenario: frozen core, SDK assembly, compatibility](#creator-scenario-frozen-core-sdk-assembly-compatibility)
- [Limits of this example](#limits-of-this-example)

## Run the example

You need Node.js 22.6 or later: the apps, the tests, and the analysis run TypeScript with `--experimental-strip-types`.
The example has four dev dependencies (ajv, ajv-formats, json-schema-to-typescript, and typescript), about 45 MB of `node_modules`.

```sh
cd examples/modular-extensions
npm install
npm run build     # core patches (+ frozen-digest check, + layout check: 0 violations) -> extension bundles + digests (+ spec lint) -> codegen -> each app's generated layer -> tsc
npm test          # 91 tests (node:test), then npm run conformance
npm run conformance   # 18 storyboards, 132 steps; rule coverage per extension
npm run docs      # docs-site/: one static page per extension + index (open docs-site/index.html)
npm run demo      # narrated walk-through (rate card, fail-closed cases)
npm run demo:pricing  # a new pricing model as an open-union branch, with real payloads
npm run app       # creator scenario: buyer app on core + 2 extensions, calls the request_makegood task
npm run agent     # sales agent: plain attributes and a typed task handler, driven by a buyer on the same layer
npm run release:pricing  # a minor release of one buying layer (buying/pricing 1.0 -> 1.1), run on a scratch copy
npm run sdk       # adcp.config.json -> adcp.lock.json + adcp-sdk/ for each app (the generated binding)
npm run sdk:check # fail when a generated layer is stale against its adcp.config.json (the CI gate)
npm run sdk -- examples/buyer-app --core 4.0.0   # dry run against a simulated core 4.0
npm run registry:reset  # rebuild registry/: current versions plus generated history fixtures
npm run analysis  # analysis/size-comparison.json, analysis/slide-excerpts.{json,md} (needs the PR ref; see below)
```

`npm run vendor-core` re-copies the core closure from a protocol checkout
(`ADCP_SRC=/path/to/adcp`, default: the adcp repo root, two levels up). It also rewrites
`core/placement.json` from the final layout's placement (`ADCP_PLACEMENT`, default
`analysis/final/raw/placement-final-v2.json`); the `--placement-only` flag rewrites only the placement.
You don't need this command to run the example.

The history-based numbers in the proposal (release counts, churn, the module cut, the final
layout, the experimental review) come from the scripts in `analysis/`. To reproduce them from this
repository's own git history, see [Analysis: where each number in the proposal comes from](analysis/README.md).

## Developer journey

A developer extends AdCP in one of two ways: (a) add parameters to the request or response of a
task that a module defines, or (b) add a task, which is an MCP tool or A2A skill. Both go through
the same six steps, and both touch only the extension package. The worked case for both is
`makegood-units`: (a) make-good rules in the `commercial_terms` of `request_proposals`, and (b) the
`request_makegood` task. `analysis/slide-excerpts.md` has the exact excerpts for every step,
cut from this run and from the built files.

| Step | (a) Add parameters to a module's task | (b) Add a task |
|---|---|---|
| 1. The payload you want | `request_proposals` carries `understood_extensions`; `commercial_terms.extensions` carries one entry `{uri, digest, data}` | Capabilities map `x_request_makegood` to `…/makegood-units#request_makegood`; the call and its response |
| 2. Declare it | `schema.json` (`MakegoodTerms`), `extension.json` (`extends: commercial_terms`), `spec.md` rules, storyboards | `schema.json` (`MakegoodRequest`, `MakegoodResponse`), `extension.json` (`extends: task`, `branch`, `response`), rules [MG-R18](packages/ext-makegood-units/spec.md#mg-r18-the-seller-declares-the-task-and-the-buyer-calls-the-declared-name) to [MG-R22](packages/ext-makegood-units/spec.md#mg-r22-the-buyer-validates-the-response), `conformance/05-request-makegood.yaml` |
| 3. Why nothing else changes | Buying declares the `commercial_terms` extension point once | The kernel declares the `task` union once, on its own declaration type |
| 4. Negotiation on the wire | `declared_extensions` (seller), `understood_extensions` (buyer), exact `uri@digest` | The same, plus `declared_extensions[].tasks`: transport name to task ID |
| 5. Generated code | The app lists `"makegood_units": "…/makegood-units@^1"` in `adcp.config.json` and runs `npm run sdk`. `adcp-sdk/types.ts` gets `CommercialTerms` with `makegood_units?: MakegoodTerms` and `MediaBuyState` with `makegood_units?: MakegoodLedger` | The same config line and command. `adcp-sdk/types.ts` gets `Tasks.request_makegood`, `Client.requestMakegood(request)`, and `Server` (`BoundServer<Forms, Tasks, Attribute>`) |
| 6. Use it | Seller: `terms.makegood_units = { rules }` (`examples/sales-agent/agent.ts`). Buyer: `terms.makegood_units?.rules[0].max_units` (`examples/buyer-app/app.ts`) | Seller: `server.handle('request_makegood', handler)`. Buyer: `client.requestMakegood(request)` |

Step 3 is a test, not a claim. `test/contributed-task.test.mjs` computes every layer digest before
and after a buyer and a seller enable `makegood-units` and call `request_makegood`. It then compares
the digests with `core/release.json`. `test/generated-binding.test.mjs` hashes the core schemas, the core
package, the SDK, and every extension package before and after an app adds an extension and
regenerates: only the app's own layer changes. The kernel is `sha256:3f8ca048231a…`, `buying/commitment`
`sha256:4910acbb2ae8…`, and `buying/execution` `sha256:1bb0acbd1b86…` before and after. The version without the task
(1.3.0, a registry fixture) and the version with it (1.5.0) check against the same frozen release.

## Generated binding

The app declares its extensions once and generates its own typed layer, the way protoc, GraphQL
Codegen, or Prisma do. Extension data becomes a plain attribute; the wire stays the extension
envelope `{ uri, digest, data }` at each extension point.

**1. Declare.** The buyer app declares its extensions in `examples/buyer-app/adcp.config.json`. Each key is the attribute the app reads and
writes; each value is a URI with a version range or a digest pin:

```json
{
  "core": "3.3.0",
  "extensions": {
    "seller_adjustable_terms": "https://extensions.adcontextprotocol.org/seller-adjustable-terms@^1",
    "makegood_units": "https://extensions.adcontextprotocol.org/makegood-units@^1"
  }
}
```

**2. Generate.** `npm run sdk` runs `scripts/adcp-sdk.mjs` on each app. It resolves each range
against the registry and the pinned core, verifies the digests, writes `adcp.lock.json`, and writes
the app's layer, `adcp-sdk/`. The following table lists the files in that layer:

| File | What it holds |
|---|---|
| `bindings.ts` | `BINDING`: the extensions keyed by `uri@digest` (attribute, version, the hooks each fills, its tasks) and, per message, where each core hook sits |
| `types.ts` | `CommercialTerms` with one attribute per extension, `MediaBuyState` (readback), `PricingOption` with a member per enabled `pricing_model` branch, `Proposal`, `MediaBuy`, `Tasks`, `Client`, `Server` |
| `index.ts` | `createClient()`, `createServer()`, `parse()`, `serialize()`, `termsDigest()`, `wireSchema()`, `understoodExtensions()`, and the extensions' own types |
| `bundles/` | The pinned bundles; the SHA-256 hash of each file is its digest |
| `GENERATED.json` | The inputs that each generated file comes from |

`npm run sdk:check` fails when a layer is stale against its config, which is the continuous integration (CI) gate.

**3. Use.** The buyer (`examples/buyer-app/app.ts`) reads attributes and calls the task:

```ts
const client = await createClient({ transport: seller.transport, onViolation: (v) => log(`DISPUTE ${v.message}`) });
const { proposals = [] } = await client.requestProposals({ idempotency_key, brief, brand });
const cap = proposals[0].commercial_terms.makegood_units?.rules[0].max_units ?? 0;
const answer = await client.requestMakegood({ media_buy_id, rule_id: 'mg_video_2', package_id: 'pkg_video_2', reason: 'deliverable_missed', idempotency_key });
```

The seller (`examples/sales-agent/agent.ts`) writes attributes and serves the task:

```ts
const server = createServer({ protocols: ['media_buy'] });
if (ctx.understands('makegood_units')) terms.makegood_units = { rules: [rule(0), rule(1)] };
server.handle('request_makegood', (req) => { /* req: MakegoodRequest; returns MakegoodResponse */ });
buy.makegood_units = { issued: [unit] }; // the media_buy_state readback
```

The app code has no casts, no registry, and no reference to `extensions`, `uri`, or `digest`.

### How it works

- **Composition at generation time.** `scripts/generated-binding.mjs` walks the pinned core from the
  root schema of each message the SDK reads or writes, through `$ref`, `allOf`, `anyOf`, `oneOf`, and
  `items`, and records every `x-adcp-extension-point` and `x-adcp-open-union` it reaches with its
  data path (`proposals[].commercial_terms`, `media_buys[]`, `products[].pricing_options[]`). The
  types re-point only the hook hosts. The SDK's task types (`lib/client.d.mts`) take the form of each
  hook as a type parameter, so `Proposal<Forms>` carries the app's `CommercialTerms`. Every other
  core type stays the core package's.
- **The mapping at run time.** `lib/binding.mjs` decodes each response from the wire to attributes
  and encodes each message back. It holds no state; every function takes the frozen `BINDING`.
  The buyer client runs the SDK client underneath, so wire validation, must-understand, the extension's
  `check()`, and the `terms_digest` check before accept all still run on the wire form. A parsed
  object re-encodes to the same bytes. The layer keeps per-entry `must_understand` flags, and ignorable
  entries that this build doesn't know, on the host under a non-enumerable symbol, and writes them back.
- **The extension package** keeps its types, its literal URI and digest, and its task descriptors.
  The layer imports them; it never writes into the core package or the SDK.

### What the boundary sees

The tests in `test/generated-binding.test.mjs` and `test/types/generated-binding.ts` check the
following four properties.

- **The published schema is the wire schema.** `wireSchema('request_proposals.response')` returns a
  self-contained JSON Schema of the wire form: `commercial_terms.extensions[]` with the
  `x-adcp-extension-point` annotation and an `x-adcp-extensions` list of the `uri@digest` set this
  build understands. It never lists the attributes, so a boundary that strips undeclared fields keeps
  the envelope, and the attribute form fails it (`commercial_terms` is closed).
- **Errors come back at wire locations.** A seller that writes `max_units: 0` gets
  `INVALID_RESPONSE` at `/proposals/0/commercial_terms/extensions/0/data/rules/0/max_units`, not at
  the attribute path the peer never sees. The SDK refuses an unknown must-understand entry at
  `/proposals/0/commercial_terms/extensions/0` (`EXTENSION_NOT_UNDERSTOOD`). It refuses a known URI with
  another digest at the same location (`EXTENSION_VERSION_NOT_UNDERSTOOD`), with a message that says
  to pin the version in `adcp.config.json` and run `npm run sdk`.
- **Several versions of one URI.** The layer keys bindings by `uri@digest`. Two keys may name two
  versions; each is its own attribute, and the earlier version's types take a version suffix
  (`seller_adjustable_terms` and `seller_adjustable_terms_v1_0`, `SellerAdjustableTermsV1_0_0`). A
  message carries one entry per URI, so the layer refuses a message that sets both (`EXTENSION_VERSIONS`).
- **One layer per app, the superset; enablement per tenant.** The layer holds every extension any
  tenant of the deployment may enable (`test/apps/superset`). `createServer({ tenants })` takes
  per-tenant enablement as data. After the transport resolves the tenant, the boundary filters the
  capabilities and intersects `understood_extensions` with the tenant's set (`ctx.understands()`).
  It refuses a contributed task that the tenant didn't enable, and it refuses must-understand data that
  the caller didn't list (`EXTENSION_NOT_AGREED`).

The indexed cost-per-point (CPP) pricing model is a member of the pricing union: narrowing on
`option.pricing_model === '…/linear-tv-indexed-cpp#indexed_cpp'` gives
`option.linear_tv_indexed_cpp: IndexedCPP`, and the core members keep `fixed_price`.

### Limits

- **One regeneration per change.** Adding or removing an extension, or moving to another version, needs
  `npm run sdk` and a deploy. `npm run sdk:check` catches a stale layer in CI; at run time the digest
  catches it.
- **The SDK's task types are a hand-written subset** (`lib/client.d.mts`), because
  json-schema-to-typescript collapses the `allOf`-based task schemas (design issue 10). The hook
  forms are a type parameter of that subset.
- **The layer re-points only the hooks the core declares** in the messages the SDK handles
  (`MESSAGES` in `scripts/generated-binding.mjs`).

### Alternatives

- **Runtime binding.** One shared SDK; the client enables extensions at run time
  (`createAdcpClient({ extensions })`) and binds each entry from a registry at parse time. The app
  reads typed data through accessors (`readCommercialTerms()`, `client.ext(module)`). It needs no
  regeneration, and the example keeps it only for runtime plug-ins: hosts that load an extension by `uri@digest` at
  run time, such as the conformance runner and the mock sellers that serve registry versions. The
  generated layer runs on it underneath.
- **Inline fields.** Extension data as namespaced fields directly on the host object, with no
  envelope. This design is rejected: the wire key carries no digest, so a receiver can't tell versions apart or
  enforce must-understand.

## Contributed tasks

A module owns its tasks in the flat task namespace. An extension adds a task the same way it adds
a pricing model: as a branch of an open union, here the kernel's `task` union.

- **Identity.** The task ID is a branch ID, `<uri>#<task>`:
  `https://extensions.adcontextprotocol.org/makegood-units#request_makegood`. It carries no
  digest, so code that names the task survives a digest change.
- **Registration.** The manifest registers the branch with its request and response definitions:
  `{ "point": "task", "branch": "request_makegood", "definition": "MakegoodRequest", "response": "MakegoodResponse" }`.
  The union's owner, the kernel, requires `response` (`branch_requires`), and the build refuses a
  registration without it or with a definition the bundle lacks.
- **Declaration and transport name.** MCP tool names don't fit a URI, so the seller maps a
  transport name to the task ID in its declaration. The kernel requires the `x_` prefix, which keeps
  every contributed name clear of the tasks modules define:

  ```json
  {
    "uri": "https://extensions.adcontextprotocol.org/makegood-units",
    "digest": "sha256:0debf79a7390…",
    "points": ["commercial_terms", "media_buy_state", "task"],
    "tasks": [{ "name": "x_request_makegood", "task": "https://extensions.adcontextprotocol.org/makegood-units#request_makegood" }]
  }
  ```

  The name is the seller's choice; another agent may serve the same task ID under another name.
- **Discovery.** A buyer that understands the extension at the exact `uri@digest` resolves the task ID to
  the transport name (`negotiate().tasks`). A buyer that doesn't ignores the binding: the union's
  policy is `must_understand: never`, because a declaration offers a task and obliges no one.
- **Dispatch and validation.** The buyer sends the request definition as the task arguments under
  the transport name and receives the response definition, which carries the kernel task status
  by `$ref`. The seller validates the request and its own response, and the buyer validates both
  and runs the extension's `check()` on the response, all against the declared `uri@digest`.

The kernel's additions for contributed tasks are all generic, and all live in `core/patches.json`. The following table lists them:

| Addition | File | Why it is generic |
|---|---|---|
| `tasks[]` of `ExtensionTask` `{name, task}`, annotated as the `task` open union | `core/extension-declaration.json` | It names no extension and no task; the kernel declares the hook on its own type, like `capabilities` |
| `OpenUnion.identity` (`entry` \| `enclosing`) and `OpenUnion.must_understand` (`always` \| `never`) | `core/extension-hook.json` | A union whose host carries no body, because the enclosing declaration names the extension, and a union whose branches are offers |
| Rule 7 in the hook vocabulary | `core/extension-hook.json` | One sentence: an extension adds a task as a branch of `task`, served under a declared transport name |
| `task` (major 1) in the kernel's release entry | `core/release.json` | The hook's contract major, like every hook |

The following table lists the generated APIs:

| Side | API | Where |
|---|---|---|
| Buyer | `client.requestMakegood(request): Promise<MakegoodResponse>` | the app's `adcp-sdk/types.ts` (`Client`), from `lib/binding.mjs` `createBoundClient()` |
| Seller | `server.handle('request_makegood', (request, ctx) => MakegoodResponse, { name? })` | the app's `adcp-sdk/types.ts` (`Tasks`, `Server`), from `lib/binding.mjs` `createBoundServer()` |
| Both | `tasks.requestMakegood: ContributedTask<MakegoodRequest, MakegoodResponse>`, `REQUEST_MAKEGOOD` | `packages/ext-makegood-units/src/index.ts` (and `index.mjs`); the generated layer calls and serves the task through it |
| Both | `ContributedTask<Request, Response>`, defined once | `packages/core/src/index.ts` |

## Where an extension's rules live

An extension adds fields, and the digest pins them. The rules that give the fields meaning
can't live in the JSON, so each package carries the following five parts:

| Part | File | Normative | In the digest |
|---|---|---|---|
| Schema | `schema.json` | Yes | Yes, as the bundle itself |
| Spec | `spec.md`: RFC 2119 rules, one ID each ([MG-R3](packages/ext-makegood-units/spec.md#mg-r3-rule-ids-are-unique-and-in-order)) | Yes | Yes, by SHA-256 hash in `docs.spec` |
| Declarative constraints | `x-adcp-validation.verifier_constraints` in `schema.json`, the #8102 convention | Yes | Yes, as part of the schema |
| Conformance storyboards | `conformance/*.yaml`: steps, expected outcomes, and the rule IDs they test | Yes (as tests) | Yes, by SHA-256 hash in `docs.conformance[]` |
| Reference code | `index.mjs` `check()` | No | Yes, by SHA-256 hash in `docs.reference_code` |

The parts fit together as follows:

- **The digest pins the rules and the code.** `build-extensions.mjs` hashes `spec.md`,
  each storyboard, and `index.mjs` into the manifest
  (`docs: {spec: {path, sha256}, conformance: [...], reference_code: {path, sha256}}`)
  before it computes the digest. Editing one sentence of prose, or one line of code, gives a
  different digest, and the registry refuses it under the same version (`test/docs.test.mjs`). The
  registry stores the documents and the code next to the bundle, keyed by the same digest:
  `registry/<host>/<path>/<hex>/spec.md`, `.../<hex>/index.mjs`.
- **The loader runs only pinned code.** `loadModule()` (`lib/buyer-validator.mjs`), which
  the client uses to enable an extension, verifies the bundle digest, then hashes `index.mjs`
  and compares it with `docs.reference_code` **before** it imports the file. A mismatch
  fails closed with `EXTENSION_CODE_MISMATCH`; a bundle that pins no code fails with
  `EXTENSION_CODE_UNPINNED`. When the SDK generates the code for a schema-only extension, the
  lock marks it `code: "schema-only"`, and the code must be the SDK's fixed stub, byte for byte
  (`SCHEMA_ONLY_CHECK`). The conformance runner applies the same check before it runs a suite.
- **Every requirement has an ID.** A rule is a `#### XX-Rn: title` block with an
  `Enforced by:` line: `kernel`, `schema`, `x-adcp-validation <group.key>`, `check()`, or
  `conformance only`. The build fails when a MUST or SHOULD sits outside a rule, or when a
  rule cites a constraint the schema lacks. It also fails when a declared constraint has no
  rule, or when a storyboard cites an ID that the spec doesn't define (`lib/extension-spec.mjs`).
- **Some rules are conformance only.** The buyer SDK can't check them, so only the
  storyboards do. For example, [SAT-R17](packages/ext-seller-adjustable-terms/spec.md#sat-r17-a-budget-release-never-covers-the-sellers-own-shortfall) reads "a seller MUST NOT use a budget release to cover a
  shortfall it caused". `check()` accepts such a release; the storyboard flags it.
- **The runner grades the suites.** `scripts/run-conformance.mjs` checks that each
  storyboard is the exact file the digest pins, runs it against the mock sellers and the
  buyer SDK, and reports per extension which rules have a passing storyboard. It fails
  when a step fails or when a MUST rule has no passing storyboard. It also fails when a suite lacks a
  Generate Random Extensions And Sustain Extensibility (GREASE) step (RFC 8701) for the reject path
  or the ignore path. A GREASE step injects an
  extension with a random `uri@digest`: the buyer must reject it at a must-understand hook
  and ignore or drop it at an optional one.
- **The docs site renders from the registry.** `scripts/render-extension-docs.mjs`
  reads each `uri@digest` from the registry, re-verifies every document hash, and writes
  `docs-site/<name>.html` (URI, version, digest, the reference-code pin, hooks with the core
  layer that owns each, must-understand policy, rules with IDs, storyboard coverage) and
  `docs-site/index.html`. Each page is self-contained and uses a light theme. Each rule heading carries the rule ID as
  its anchor (`makegood-units.html#MG-R9`).

The following table lists the result of `npm run conformance`.

| Extension | Version | Rules covered | MUST covered | Conformance only | Storyboards | Steps |
|---|---|---|---|---|---|---|
| `seller-adjustable-terms` | 1.6.0 | 18/18 | 17/17 | 3 | 5 | 41 |
| `makegood-units` | 1.5.0 | 22/22 | 21/21 | 6 | 5 | 41 |
| `rate-card-index` | 1.5.0 | 9/9 | 9/9 | 1 | 3 | 16 |
| `linear-tv-indexed-cpp` | 1.5.0 | 14/14 | 13/13 | 3 | 4 | 29 |
| `daypart-codes` (vendor) | 2.6.0 | 3/3 | 3/3 | 1 | 1 | 5 |

The registry has a clean, reproducible history. `npm run registry:reset` clears `registry/`,
publishes each package at its checked-in version, and then runs `scripts/registry-history.mjs`.
That script generates, from the checked-in sources, the earlier versions that tests and storyboards
pin. Each is the same set of files under an earlier version number. `seller-adjustable-terms` 1.0.0
also lacks the `media_buy_state` readback hook, and `makegood-units` before 1.4.0 lacks
the `request_makegood` task. Each version has its own digest. Storyboard steps use a
small task vocabulary (`get_products`, `request_proposals`, `refine_proposals`, `accept_proposal`,
`get_media_buys`, `capabilities`, `call_task` for a contributed task, `seller_op`, `validate`
with `mutate` and `grease`, `assert`); the
header of `scripts/run-conformance.mjs` lists it. The data format follows the AdCP storyboards
in `static/compliance/source/` (`id`, `phases[].steps[]`, `expected`, `validations`),
with `covers` added for rule IDs.

## Final layout

`core/placement.json` follows the final layout (`analysis/final/raw/placement-final-v2.json`, which
`analysis/run_all.sh` regenerates). The layout is a star around the kernel, with a layered buying module:

- **The kernel layer** is the kernel (`core`) and kernel types.
- **Nine standard modules** (buying, creative, governance, reporting, accounts, signals, identity,
  sponsored-intelligence, trusted-match) and the compliance-testing leaf each reference only the kernel layer.
- **Buying has eight layers**: targeting, pricing, catalogs, commitment, supply, offer, execution, and
  delivery. Each layer references only the kernel layer and the layers below it. Pricing and catalogs are
  siblings, and so are offer and execution.
- **Fourteen bridge extensions** (C1 to C12) carry the features that combine two modules. A bridge fills an
  extension point that one module declares, under the host's property name, so no payload changes.
- **Assemblies compose modules by definition.** The generated `_assembly` holds the capabilities response
  and other generated files. The **3.x compatibility assembly** (`_compat`) holds the legacy formats whose
  references to modules go away only with removals that 4.0 already slates; 4.0 removes the assembly.

`vendor-core.mjs` maps each layout label to a layer: `kernel` -> `core`, `kernel-types` ->
`kernel-types`, `assembly` -> `_assembly`, `module:<m>` -> `<m>`, `module:buying/<l>` -> `buying/<l>`,
and `extension:<x>` -> `x-<x>`. Each buying layer is its own layer with its own version and frozen digest;
there is no `buying` layer. `node scripts/vendor-core.mjs --placement-only` rewrites `core/placement.json`
from the files already vendored, so the vendored bytes stay at `4f811d253e`. The layout was computed at
`ad1f380f8c`; every vendored path exists there, and the placement is by path. `lib/layout.mjs` holds the
shared names and rules. The following table lists the layers of the pinned bundle (`core/release.json`).

| Layer | Role | Version | Depends on | Files | Hooks (major) | Digest |
|---|---|---|---|---|---|---|
| `core` | kernel | 3.3 | | 17 (13 vendored, 4 created) | `capabilities`, `task` (1 each) | `sha256:3f8ca048231a…` |
| `kernel-types` | kernel types | 3.3 | | 90 (87 vendored, 3 created) | none | `sha256:e50cd6e3609f…` |
| `buying/targeting` | buying layer | 1.0 | kernel layer | 63 | none | `sha256:03f992ef0b5e…` |
| `buying/pricing` | buying layer | 1.0 | targeting | 21 (20 vendored, 1 created) | `pricing_model`, `pricing_option` (1 each) | `sha256:9867a778b956…` |
| `buying/catalogs` | buying layer, opt-in | 1.0 | targeting | 2 | none | `sha256:fc63dd0e20bb…` |
| `buying/commitment` | buying layer | 1.0 | pricing | 38 | `commercial_terms` (1) | `sha256:4910acbb2ae8…` |
| `buying/supply` | buying layer | 1.0 | commitment, catalogs | 97 | none | `sha256:d7fc6bea6c36…` |
| `buying/offer` | buying layer, opt-in | 0.1 | supply | 7 | none | `sha256:88b4f306eeef…` |
| `buying/execution` | buying layer | 1.0 | supply | 10 | `media_buy_state` (1) | `sha256:1bb0acbd1b86…` |
| `creative` | module | 1.0 | | 61 | none | `sha256:f468c73857f7…` |
| `reporting` | module | 1.0 | | 16 | none | `sha256:3bddacca1c44…` |
| `accounts` | module | 1.0 | | 11 | none | `sha256:4de802996f69…` |
| `signals` | module | 1.0 | | 4 | none | `sha256:273340512a44…` |
| `identity` | module | 1.0 | | 3 | none | `sha256:497c6c4f9770…` |
| `governance` | module | 1.0 | | 1 | none | `sha256:f24c37db3831…` |
| `sponsored-intelligence` | module | 1.0 | | 1 | none | `sha256:e3aaa1dfa692…` |
| `_assembly` | assembly | 3.3 | | 3 | none (holds the kernel's `declared_extensions` and `modules`) | `sha256:1895c6bce9ca…` |
| `_compat` | assembly (3.x compatibility) | 3.3 | | 2 | none | `sha256:85b3382f54cf…` |
| `x-audience-evidence-on-products` | extension (C6) | 0.1 | | 3 | none | `sha256:ee98edecf1ce…` |
| `x-reliable-reporting-account-attachments` | extension (C2a) | 0.1 | | 2 | none | `sha256:c5127a248ff8…` |
| `x-format-declarations-on-products` | extension (C4) | 0.1 | | 1 | none | `sha256:9b016ef99c6f…` |
| `x-spot-lifecycle` | extension | 0.1 | | 1 | none | `sha256:ce388760ebcd…` |

The following notes apply to the table:

- **446 vendored files, 454 in the bundle.** The patches create 8 files: 4 kernel files, 3 kernel types
  (`core/format-kind-id.json`, `core/indicator-type-id.json`, `core/media-asset.json`), and
  `pricing-options/extension-option.json` in `buying/pricing`.
- **"Depends on" is the release's `depends_on`**: the layers directly below, as in the layout's layer
  directed acyclic graph (DAG). The full set includes everything below those. Offer starts at `0.x`, as the layout's `modules` map
  does.
- **Three layout units own no vendored file**: trusted-match, the compliance-testing leaf, and
  `buying/delivery`. They have no layer entry.
- **The 3.x compatibility assembly is the one declared departure from the layout file.** It holds
  `core/product.json`, the legacy `get_products` product, and `core/product-signal-targeting-option.json`,
  its signal targeting option listing. The layout places them in `buying/supply` and `buying/targeting`.
  Their references to signals go away only with the 3.x compatibility facades, which 4.0 already slates for
  removal. `core/placement.json` `compat_assembly` lists each file with its layout label and the reason,
  from `COMPAT_ASSEMBLY` in `scripts/vendor-core.mjs`. The layout's 3.4 migration also generates each legacy
  twin from its canonical format, so the legacy product is an assembly either way.
- **Files that the layout places in an extension stay their own layers.** Three bridges hold files (C2a,
  C4, C6), and `enums/spot-status.json` belongs to `spot-lifecycle`. Each is a layer with role
  `extension`.

Each hook belongs to the layer that declares it, as the following table shows:

| Hook | Kind | Policy | Owner | Major |
|---|---|---|---|---|
| `capabilities` | extension point on `ExtensionDeclaration` | `never`, `identity: enclosing` | kernel (`core`) | 1 |
| `task` | open union on `ExtensionDeclaration.tasks[]` | branch `never` (an offer), `identity: enclosing`, `branch_requires: response` | kernel (`core`) | 1 |
| `pricing_option` | extension point on `cpm-option`, `cpp-option`, `extension-option` | `flag` | `buying/pricing` | 1 |
| `pricing_model` | open union on `extension-option`, `canonical-pricing-option` | branch `always`; `unknown_in_list: drop_option` | `buying/pricing` | 1 |
| `commercial_terms` | extension point on `commercial-terms` (`extensions`) | `always`, `order: uri` | `buying/commitment` | 1 |
| `media_buy_state` | extension point on `get-media-buys-response` media buys (`extensions_state`) | `never` | `buying/execution` | 1 |

The request-side `understood_extensions` stays in the kernel envelope (`core/version-envelope.json`).
`buying/offer` declares no hook: it only lets its closed `request_proposals` and `refine_proposals`
requests carry the envelope field by `$ref`.

Patch ownership follows the layers. `core/patches.json` has nine groups (`core`, `_assembly`,
`kernel-types`, `accounts`, `buying/pricing`, `buying/commitment`, `buying/supply`, `buying/offer`,
`buying/execution`), and the build refuses a patch on a file another layer owns. For example, a
`buying/pricing` patch on `core/duration.json` fails with "belongs to layer kernel-types", and one on
`media-buy/commercial-terms.json` fails with "belongs to layer buying/commitment".

### The layout's rules on the vendored subset: zero violations

`scripts/layout-lint.mjs` runs after `build-core.mjs` in `npm run build:core`, and `test/layering.test.mjs`
runs the same checks (`lib/layout.mjs` `classifyRef()`) on every `$ref` between two core files. In these
checks, "references" means "has a `$ref` to":

- **Star:** a module references no other module, and the kernel layer references no module.
- **Layers:** a buying layer references only the kernel layer and the layers below it.
- **Siblings:** pricing and catalogs never reference each other, and neither do offer and execution.
- **Extensions:** a module references an extension's file only under a bridge point that the extension
  fills, and an extension references only the modules it connects.

An assembly composes modules by definition, so the checks skip `_assembly` and `_compat`. The checks cover
only the vendored subset (446 upstream files and the 8 the patches create), not the whole tree. They're
blocking: any violation fails the build and `npm test`, and the checks have no baseline. A test adds one
module-to-module `$ref` in a scratch patch and checks that the lint reports it.

Upstream breaks the rules at 45 places in this subset. `core/patches.json` applies the layout's 3.4 fix for
each one, as the proposed 3.4 core change, and each fix keeps the wire bytes. A test matches every upstream
violation to its patch and checks the fix ID against `crossing-edges-v2.csv`:

| Fix | What the patch does | Occurrences | Fix IDs |
|---|---|---|---|
| Bridge points | Adds `x-adcp-bridge-point` (`{bridge, extension}`) to the host property. The 3.4 build assembles the host schema from the bridge under the host's property name, so a `$ref` under the point belongs to the bridge, which may reference both modules it connects. A point must sit in the bridge's declaring module. | 23 | C6 (13), C4 (4), C3 (3), C2a (1), C8 (1), `spot-lifecycle` (1) |
| Kernel types with registry composition (op `compose`) | The field is typed with a kernel open ID or core, and the build composes the module's registry (its known values) into the published schema: `{ allOf: [{ $ref: <kernel type> }, <the module's definition>], "x-adcp-registry": <its $id> }`. Inside the composed definition, the build composes every `$ref` outside the kernel layer the same way. The field accepts exactly what it accepted before; a test validates every known value and an unknown one before and after. | 15 | `media_asset` (7), `format_kind_id` (3), `indicator` (3, a wrapper that buying owns), `indicator_type_id` (2) |
| 3.x compatibility assembly | `core/product.json` and `core/product-signal-targeting-option.json` move to `_compat`. Two of their references go away only with the slated 4.0 removal of the compatibility facades; the other 5 are inside the legacy product. | 7 | slated (2), legacy product (5) |

`patches.json` `registries` maps each module registry to its kernel type: `core/canonical-format-kind.json`
to `format-kind-id`, `enums/indicator-type.json` to `indicator-type-id`, and the five creative asset
formats to `media-asset`. The other kernel-type fixes in the layout (definition moves, the remaining
open IDs, and the 9 bridges with no host in this subset) have no `$ref` here to fix.

After the fixes, the subset has 0 violations: 23 `$ref` values sit under bridge points, and 41 fields are
composed from registries. The fixes change schemas, not payloads. They move the bundle digest, and the
build re-stamps every layer that holds a fixed file (`--freeze`). The optional `modules` map (see
[Module versions](#module-versions-a-minor-release-and-the-modules-map)) moves only `_assembly`. The
bundle digest is `sha256:26d4e59152ab…`. The
kernel (`core`), the other modules, and the extension layers don't move. No extension byte changes, so
no extension takes another version; only the apps' `adcp.lock.json` files pick up the bundle digest.

## Module versions: a minor release and the modules map

Each module and buying layer has its own version and frozen digest in `core/release.json`. Two pieces
make that usable: a module can ship a minor release without moving anything else, and buyers and sellers can
see each other's module versions.

### A minor release of one buying layer

`npm run release:pricing` runs `scripts/module-release.mjs` on a scratch copy of this example; the
example itself stays at buying/pricing 1.0. The release file, `core/releases/buying-pricing-1.1.json`,
names the layer, the version before and after the release, and one additive patch: an optional
`base_spot_length_seconds` on the CPP pricing option. The script runs the following steps:

1. Adds the patch to the layer's group in `core/patches.json` and runs the core build, which fails
   with `LAYER MOVED` for every layer whose files changed. Only buying/pricing moves.
2. Runs the additive check (`lib/additive.mjs`) over the 21 files the layer owns. An added optional
   property, an added definition, and an annotation are additive. A removed property, a property made
   required, a changed type, bound, pattern, or enum, or an added validation keyword on a released node is not.
3. Stamps 1.1 and re-freezes. One of 22 layers changed; the kernel, governance, and every other layer
   keep their version and digest. The bundle digest moves, because it hashes every layer.
4. Rebuilds every extension against the 1.1 release: 5 of 5 digests identical, all compatible.
5. Regenerates two apps. `test/apps/governance-only` names its modules in `adcp.config.json`
   (`"modules": ["governance"]`), so its lock pins the kernel layer and governance, one version and
   digest each, and its lock and generated layer stay byte-identical. `examples/buyer-app` names no
   modules, so it pins the whole bundle, and its lock moves.
6. Runs the release's `refused` patches, which make the same field required, on a second copy. The
   additive check refuses them; a forced re-stamp fails in the core build itself (`NOT ADDITIVE`), and
   the build re-stamps nothing.

The gate is general: `build-core.mjs --freeze` rebuilds each moved layer as of its last release (the
patches `core/release-baseline.json` records). It refuses any non-additive change within the layer's
major version, whichever script made it. The build also refuses an edit to, or a removal of, a released patch.

`test/module-release.test.mjs` asserts each step. `analysis/slide-excerpts.md` § Module release has
the run's output.

### The modules map

The kernel's fragment of the generated capabilities response (`core/patches.json`, layer `_assembly`)
carries one optional map, from the module or layer name to its version and frozen digest:

```json
"modules": {
  "buying/offer": { "version": "0.1", "digest": "sha256:88b4f306eeef…" },
  "buying/pricing": { "version": "1.0", "digest": "sha256:9867a778b956…" },
  …
}
```

- **The sellers emit it.** `createAdcpServer({ modules })` lists the modules and buying layers an agent
  implements. The creator network and the TV sales house list six buying layers each; neither sells
  from catalogs, so neither lists `buying/catalogs`. A seller that doesn't negotiate proposals leaves
  `buying/offer` out.
- **The client checks it against the lock** (`lib/modules.mjs` `checkModules()`). For each module the
  app expects (its lock's module pins, or every module of the bundle it pins) the result is `same`,
  `seller-newer` or `seller-older` (another minor: compatible), `not-offered`,
  `MODULE_MAJOR_MISMATCH`, or `MODULE_DIGEST_MISMATCH` (the same version with another digest). The
  client refuses a core task before the call when any buying layer its schemas reach is missing, on another
  major version, or at another digest (`MODULE_NOT_OFFERED`, `MODULE_MAJOR_MISMATCH`, `MODULE_DIGEST_MISMATCH`).
  For example, `request_proposals` needs targeting, pricing, commitment, supply, and offer (`taskModules()`).
  The client doesn't check a seller that sends no map.
- **The SDK checks a module-pinned lock** layer by layer against the installed core (`CORE_MISMATCH` names
  the layer), not by the bundle digest.

The map moves only `_assembly` and the bundle digest; the kernel (`core`) keeps its digest.
`test/modules.test.mjs` covers the schema, what the sellers emit, and the client's check.

## The proposal flow

The worked flows use the canonical proposal lifecycle:

```
request_proposals(brief, brand, understood_extensions) -> draft canonical proposals + compact products
refine_proposals(finalize)                             -> committed proposal (commercial_terms, terms_digest)
accept_proposal(proposal_id, proposal_terms_digest)    -> media buy
```

`get_products` proposals are legacy plans and can't carry signed terms. The upstream repository
(`origin/main` `4f811d253e`) shows this in the following places:

- `static/schemas/source/media-buy/get-products-response.json:114-119`: `proposals` is
  "Optional legacy proposed media plans", with items `$ref` `/schemas/core/proposal.json`.
- `static/schemas/source/core/proposal.json` (181 lines) has no `commercial_terms` and no
  `terms_digest`. Its description says draft proposals are finalized "via get_products refine
  action 'finalize'".
- `static/schemas/source/core/canonical-proposal.json:89-90` defines `commercial_terms` and
  `terms_digest`, and `:114` requires both.
- `static/schemas/source/media-buy/request-proposals-response.json:16-29`: `proposals` items
  are `canonical-proposal.json` with `commercial_terms` and `terms_digest` required (`:27`).
  `refine-proposals-response.json:47` returns `canonical-proposal.json` too.
- `docs/media-buy/task-reference/refine_proposals.mdx:228`: "Legacy `get_products` proposals
  carry no `hold_policy`".
- `request-proposals-request.json:11` names `get_products` only as the
  `x-legacy-fallback` (`"mode": "orchestrated"`).

The example handles the proposal flow as follows:

- **Vendored.** The example vendors `media-buy/request-proposals-request.json`,
  `request-proposals-response.json`, and their closure (25 added files, among them
  `canonical-product.json`). The request is closed (`additionalProperties: false`), so buying
  redeclares `understood_extensions` on it by `$ref`, as on `refine-proposals-request.json`.
- **Mock sellers.** Both answer `request_proposals` with
  `{status: "completed", outcome: "proposed", proposals, products}`, and both validate the
  request and the response against core. The creator network has no `get_products`. The TV
  sales house keeps `get_products` for discovery only (products, no proposals).
- **Client.** `client.requestProposals()` sends `understood_extensions`, validates the whole
  `request_proposals` response (canonical proposals, compact products), and drops a compact
  product's pricing option whose branch it can't read. `getProducts()` doesn't read
  proposals. `lib/client.d.mts` holds the types (`requestProposals`, `CanonicalProduct`).
- **App, demos, tests, storyboards.** `examples/buyer-app/app.ts`, `demo-pricing.mjs`
  (steps 3 to 5), the scenario and pricing tests, and every storyboard that buys start with
  `request_proposals`. The runner has a `request_proposals` task.
- **Where `get_products` stays, and why.** Discovery-time pricing options are the point of
  the rate card (`demo.mjs`, `rate-card-index` storyboards, `demo-pricing.mjs` step 2) and of
  dropping an unknown branch from a product's option list (`linear-tv-indexed-cpp` storyboard
  02). The `pricing_option` extension point exists only on the core-model option files that
  `get_products` products carry; `canonical-pricing-option.json`, which compact products use,
  has the `pricing_model` union but no `pricing_option` extension point.

One result follows from this flow. Take a single `request_proposals` response from a seller that ignores
`understood_extensions`. The client **drops** the unknown branch from a compact product's option list
(`EXTENSION_OPTION_DROPPED`), and it **rejects** the same branch as the pricing of the signed purchase
(`EXTENSION_NOT_UNDERSTOOD`). The whole response fails closed
(`linear-tv-indexed-cpp` storyboard 03).

## Size, like for like

`analysis/size-comparison.json` (`node scripts/size-comparison.mjs`) counts lines the same way
on both sides: newline-terminated lines (`wc -l`); for #8102, git insertions against the merge
base. The following table measures #8102 at head `d3ff198051` (fetched as `refs/remotes/pr/8102`, merge base `80fe5b2c08`):

| #8102 part | Files | Lines |
|---|---|---|
| Whole PR (`git diff --shortstat origin/main...pr/8102`) | 30 | +1,681 / −23 |
| `static/schemas/source` | 16 | +872 / −19 |
| …allowance lane (what `seller-adjustable-terms` replaces) | 8 | +640 |
| …offer lane (a mechanism that stays core in both designs) | 4 | +179 / −2 |
| …mixed (one notification type per lane, index, rewording) | 4 | +53 / −17 |
| `tests/` | 1 | +642 |
| `docs/` | 11 | +155 / −3 |
| `.changeset/`, `package.json` | 2 | +12 / −1 |

The following table measures each extension package:

| Extension package | Schema and manifest | Spec | Storyboards | Reference code | Authored total |
|---|---|---|---|---|---|
| `seller-adjustable-terms` 1.6.0 | 443 | 183 | 553 | 127 | 1,306 |
| `makegood-units` 1.5.0 | 433 | 213 | 593 | 73 | 1,312 |
| `rate-card-index` 1.5.0 | 450 | 120 | 214 | 156 | 940 |
| `linear-tv-indexed-cpp` 1.5.0 | 350 | 155 | 407 | 108 | 1,020 |
| `daypart-codes` 2.6.0 | 81 | 39 | 69 | 6 | 195 |

"Schema and manifest" is `schema.json` plus `extension.json`. The counts exclude generated files
(`dist/bundle.json`, `src/index.ts`, the lock) and `package.json`. Like for like, the
counts compare as follows:

- **Schema only:** `seller-adjustable-terms` has 443 lines against #8102's 640 allowance-lane
  schema lines (872 for all of `static/schemas/source`).
- **Schema, rules, tests, and code:** 1,306 lines against #8102's 872 schema + 642 test + 155
  doc lines, which also cover the offer lane. The package isn't smaller than the core diff
  it replaces once its spec and storyboards count.
- **Core files changed:** 16 for #8102, 0 per extension. The one-time core delta
  (`core/patches.json`, 757 lines) touches 34 files, 8 of them created, and every extension
  shares it. 15 of those files (5 created) are the extension mechanism; the other 19 (3 created) apply the
  final layout's 3.4 fixes, which no extension needs.

## Slide excerpts

`node scripts/slide-excerpts.mjs` writes `analysis/slide-excerpts.md` (readable) and
`analysis/slide-excerpts.json` (data). The excerpts start with the two developer journeys (see
[Developer journey](#developer-journey)). They then give the exact hook chain for each worked example: (a) the
creator slip, (b) the creator make-good, (c) the linear-TV indexed-CPP pricing model, and (d)
the rate card as an ignorable explanation. For each example, the excerpts show the following items:

- The host schema in its module, with the annotation and owner.
- The kernel `ExtensionEntry` schema.
- The manifest (hooks, requires, docs pins) and the extension definition.
- One spec rule, with the storyboard step that covers it.
- The wire payloads (request with `understood_extensions`, response or signed terms) and the readback.
- What a buyer that doesn't understand the extension receives, and the exact error code when a seller
  sends the extension anyway.

A final section shows the kernel's generic mechanism alone, and two more show a module
release and the `modules` map. The script cuts every excerpt from a built file or from this run's
payloads, and each excerpt is 36 lines or fewer. Payloads are the real nested JSON, and a "…" marks
each omitted key or item in its own place. The script fails if an excerpt runs longer. The deck build
checks each file-based excerpt against its primary file.

## Architecture

```
                 +------------------------------------------------------+
  AdCP repo      | core/upstream/   real schemas, adcp-main @4f811d253e |
  (protocol)     | core/patches.json  the core delta, grouped by layer   |
                 +---------------------------+--------------------------+
                                             | build-core.mjs
                                             v
                 core/schemas/  = upstream + patches  (buyer's pinned core bundle)
                    |  hooks are annotated by the schema that owns them:
                    |  "x-adcp-extension-point" (extension point), "x-adcp-open-union" (union)
                    |
   codegen.mjs      v                                   build-extensions.mjs
  +--------------------------+      +-----------------------------------------------+
  | @adcp/core  (no deps)    |<-----| packages/<ext>/                               |
  |  ExtensionEntry, CPP...,  | type | extension.json  manifest (id, extends, ...)   |
  |  CommercialTerms, ...    | refs | schema.json     $refs core by absolute URI    |
  +--------------------------+      | index.mjs       check(), pinned by sha256     |
                                    | dist/bundle.json   JCS bytes (served at uri)  |
                                    | extension.lock.json {uri, version, digest}    |
                                    | src/index.ts    generated, imports @adcp/core |
                                    +-----------------------------------------------+
                                                    | registry/<host>/<path>/<hex>.json
                                                    v (simulated https hosting by uri@digest)
  Buyer runtime (lib/buyer-validator.mjs)
   0. loadModule: bundle bytes hash to the lock digest; index.mjs hashes to the bundle's
      docs.reference_code, checked before import (else EXTENSION_CODE_MISMATCH)
   1. ajv validates the core payload; the two hook keywords collect every entry at an extension point and
      every extension branch (pricing_model = <uri>#<branch>) wherever it sits in the message,
      with the hook's must-understand policy (always | flag | never; branches: always)
   2. bundled definitions (get_products `extensions` map) must hash to their key
   3. same uri with two digests in one message -> fail closed
   4. per entry: installed module for exact uri@digest? -> validate data against the
      module's definition for this point -> run module.check() (semantics)
      no module: must-understand -> REJECT; optional -> ignore (may schema-check a
      fetched copy, never interpret it)
```

### The core delta ([`core/patches.json`](core/patches.json))

`core/patches.json` groups the delta by the layer that owns each file. The build refuses a patch that touches
another layer's file. It allows additive operations (`create`, `add`, `append`, and `widen`, where a vendored
schema becomes `anyOf: [old, new]`) and one wire-preserving operation, `compose`, the 3.4 registry composition
(see [Final layout](#final-layout)). The following table lists the extension mechanism. The layout's 3.4
fixes (kernel types, registry composition, and bridge points in `kernel-types`, `accounts`,
`buying/commitment`, `buying/supply`, and `buying/execution`) are in
[The layout's rules on the vendored subset](#the-layouts-rules-on-the-vendored-subset-zero-violations).

| Layer | Change | File | Why |
|---|---|---|---|
| kernel | Added `ExtensionHook`: the `ExtensionPoint` and `OpenUnion` annotation vocabulary and its rules, including the union policy `unknown_in_list` (`drop_option` \| `reject`), and, for a union whose branches the enclosing declaration names, `identity: enclosing` and `must_understand: never` | `core/extension-hook.json` | The one generic way to open a hook. The kernel names no module's hook. |
| kernel | Added `ExtensionBranchId` `<uri>#<branch>` | `core/extension-branch-id.json` | Discriminator value of an extension branch. No digest, so a `switch` survives a digest change. |
| kernel | Added `ExtensionEntry` `{uri, digest, must_understand?, data}` | `core/extension-entry.json` | The one envelope, used by extension points and as a branch body. |
| kernel | Added `ExtensionDeclaration` `{uri, digest, points[], capabilities?, tasks[]?}` | `core/extension-declaration.json` | `points` is an open hook name, not an enum. The kernel's own hooks: `capabilities` (the extension's capability fragment) and the `task` union (`tasks[]`: transport name `x_…` -> task ID `<uri>#<task>`). |
| kernel | `understood_extensions[]` | `core/version-envelope.json` | Request-side negotiation on every request. Open requests (`get_products`) get it with no schema change. |
| `_assembly` (kernel fragment) | `declared_extensions[]` | `protocol/get-adcp-capabilities-response.json` | The kernel's block in the generated capabilities response. |
| `_assembly` (kernel fragment) | `modules`, optional: module or layer name -> `{version, digest}` | `protocol/get-adcp-capabilities-response.json` | The module and buying-layer versions an agent implements. Additive; `adcp.supported_versions` keeps its meaning. |
| `buying/pricing` | Added generic branch `ExtensionPricingOption`; union declared open with `unknown_in_list: drop_option` | `pricing-options/extension-option.json`, `core/pricing-option.json` (`append` to `oneOf`) | `pricing_model` becomes an open union. The branch carries `extension_model`; no `fixed_price`. A buyer drops an option whose branch it can't read and keeps the product's other options. |
| `buying/pricing` | `pricing_model` widened to `anyOf[enum, ExtensionBranchId]`, `extension_model`, union annotation, one `allOf` rule | `core/canonical-pricing-option.json` | The accepted `purchases[].pricing`, and a compact product's options, can carry an extension model; in signed terms it is under `terms_digest`. |
| `buying/pricing` | Extension point `pricing_option` (policy `flag`) | `pricing-options/cpm-option.json`, `cpp-option.json` | Explanatory data, such as a rate card. The quote still binds. |
| `buying/commitment` | Extension point `commercial_terms` (policy `always`, order `uri`) | `media-buy/commercial-terms.json` | Binding data under `terms_digest`. Every entry is must-understand (the JSON Web Signature (JWS) `crit` idea, RFC 7515 §4.1.11). |
| `buying/offer` | `understood_extensions` by `$ref` | `media-buy/request-proposals-request.json`, `media-buy/refine-proposals-request.json` | The requests are closed, so they redeclare the kernel envelope field, as they already do for `adcp_version`. No hook. |
| `buying/execution` | Extension point `media_buy_state` (policy `never`) | `media-buy/get-media-buys-response.json` | Readback. Never binding. |

The buying layer that owns each host schema declares the `extensions` or `extensions_state` property
there (four in all), with the policy in the annotation. `declared_extensions` is the kernel's capabilities
fragment, and `understood_extensions` is one kernel envelope field, which closed requests redeclare.

The layering test "why core must change" and the pricing test "pricing_model is an open union"
show that the change is needed. Unpatched upstream rejects `extensions` in
`commercial_terms` (`additionalProperties: false`), `uri@digest` in `extensions_supported`, and
an extension `pricing_model` in the accepted pricing (closed enum).

### An extension package

`packages/ext-rate-card-index/extension.json` (abridged):

```json
{
  "id": "https://extensions.adcontextprotocol.org/rate-card-index",
  "version": "1.0.0",
  "requires_core": ">=3.3.0",
  "extends": [
    { "point": "pricing_option",   "definition": "RateCard",        "must_understand": "optional" },
    { "point": "commercial_terms", "definition": "RateCardBinding", "must_understand": "required" }
  ],
  "adopters": [{ "party": "seller A (NL linear TV)", "since": "2026-11-01" }],
  "promotion": { "rule": "2+ adopters / 90 days, or 1 + a JIC rule", "target": "/schemas/pricing-options/rate-card.json" }
}
```

- **A task is one more registration.** `makegood-units` adds
  `{ "point": "task", "branch": "request_makegood", "definition": "MakegoodRequest", "response": "MakegoodResponse" }`:
  a branch of the kernel's `task` union, whose owner requires `response`. See
  [Contributed tasks](#contributed-tasks).
- **One extension, a different schema per hook.** At discovery the card is a planning
  aid. Inside signed terms it is bound to a purchase, and a provisional row (Ster's
  market index, fixed after booking) makes the price a ceiling.
- **The manifest is inside the digest.** `build-extensions.mjs` emits a single JSON
  Schema document, `{...schema.json, $id: id, "x-adcp-extension": manifest}`. That
  satisfies the spec's fetch contract ("the URI MUST resolve to a JSON document
  that is itself a valid JSON Schema"), and the digest also covers the
  must-understand policy and the `extends` list.
- **Core references.** An extension writes a core `$ref` as `https://adcontextprotocol.org` plus
  the core `$id`, for example
  `https://adcontextprotocol.org/schemas/core/duration.json`. The buyer resolves it from
  its local pinned bundle and never fetches it. Any other cross-origin `$ref` fails the
  build (`lintExtensionRefs`, test 3).
- **Schema is not understanding.** `index.mjs` exports `check(point, data, {enclosing})`,
  which holds the semantics JSON Schema can't express:
  - **Rate card:** an exact-decimal evaluator that reproduces the seller's
    `fixed_price` and `price_breakdown`.
  - **Allowances:** the #8102 `verifier_constraints`. The `path` must resolve in the
    purchase, IDs must be unique, and entries must be in canonical order.

  A buyer counts as understanding an entry only when it has installed the extension at
  that exact `uri@digest`.

The packages differ from the source PRs in the following ways:

- `rate-card-index` (#7955):
  - An object container, not a bare array.
  - An open, namespaced `dimension` vocabulary.
  - Explicit `premium_basis` (`indexed` | `base`).
  - Seller-declared `rounding` (Ster rounds to whole euros).
  - `index_points` rows (Ster's +30 points for a preferred position).
  - `provisional` rows with `cap` and `fixed_at`.
  - A seller quote that differs from the card is a **warning** at discovery, and an
    **error** only inside signed terms.
  - The `model` ID that #7955 asked for becomes the extension URI itself.
- `seller-adjustable-terms` (#8102):
  - `constraint` is a tagged union: `decrease` | `time_shift` | `alternates`.
  - Adding a kind adds a variant and gives a different digest. A buyer pinned to an earlier
    digest never receives a variant it can't read.

### Digest

AdCP defines the `platform-extension-ref` digest as "SHA-256 of the response body",
and both SDKs hash raw bytes (sdk-js `src/lib/v2/format-schema/fetch.ts:264`,
sdk-python `src/adcp/canonical_formats/references.py:289`). This example publishes
each bundle **as its RFC 8785 (JCS) bytes**. As a result,
`sha256(body) == sha256(JCS(parse(body)))`, which has the following benefits:

- The raw-body check in both SDKs keeps working.
- A copy embedded as a JSON value (the `get_products` `extensions` map) is verifiable
  too.
- The digest matches `terms_digest`, which already uses JCS.

Tests 6 and 27 cover this.

### Codegen

Two generators run. `scripts/codegen.mjs` compiles the core package and each extension package with
json-schema-to-typescript (the generator sdk-js uses). `scripts/adcp-sdk.mjs` then writes each app's
generated layer from those types (see [Generated binding](#generated-binding)).


- **`@adcp/core`.** `scripts/codegen.mjs` compiles core into one `packages/core/src/index.ts`
  (142 types from 103 schemas). It has no imports.
- **Extension packages.** Each extension's `$ref` to a core URI becomes
  `tsType: "<CoreName>"`, so its package emits
  `import type { Duration, ExtensionEntry } from '@adcp/core'` and its own types.
- **Task descriptors.** A task gets its ID constant and a typed descriptor in `tasks`
  (`ContributedTask<Request, Response>`, which `@adcp/core` defines once). The generated layer turns
  each into a client method and a handler.
- **Runtime-binding helpers, for runtime plug-ins.** Each package also gets, per extension point, a
  typed entry alias where `uri` and `digest` are literal types, a reader that matches only this exact
  `uri@digest`, and a writer that builds the envelope. Apps don't use them; a host that enables the
  extension at run time does (the conformance runner, and the mock sellers that serve registry
  versions):

  ```ts
  export type RateCardIndexPricingOptionEntry = Omit<ExtensionEntry, 'uri' | 'digest' | 'data'> & {
    uri: typeof EXTENSION_URI; digest: typeof EXTENSION_DIGEST; data: RateCard;
  };
  export function pricingOptionEntry(data: RateCard): RateCardIndexPricingOptionEntry;
  ```

  A branch gets its ID constant, a typed branch, a reader, and a writer (`indexedCppBranch()`);
  the kernel's `capabilities` fragment gets a reader and a typed `capabilitiesFragment()`.
- **A JavaScript twin.** `src/index.mjs` is the same code with the types erased (TypeScript
  `transpileModule`), so the plain-JavaScript mock sellers import the runtime-binding writers too.

`test/types/generated-binding.ts` (`npm run typecheck`) checks the generated layers. Attributes are
typed from each extension's schema, and a misspelled attribute or field fails to compile. Dropping an
extension from the config breaks every use, a task handler must return the response type, and
narrowing on the indexed-CPP branch ID gives its data. `test/types/usage.ts` checks the following
properties of the packages and the runtime binding:

- A typed rate-card entry fits a core `CPPPricingOption` with no conversion.
- A core-only consumer still compiles.
- An entry with the wrong digest, or a `kind` the digest doesn't define, fails to compile.
- A task handler must return the task's response type, and a request must match its request type.

## Directory tree

```
modular-extensions-example/
  README.md
  package.json  tsconfig.json  demo.mjs
  core/
    UPSTREAM.json          source commit + sha256 of every vendored file
    upstream/              446 schemas, byte-identical to adcp-main @4f811d253e
    placement.json         file -> owning layer (the final layout; buying layers as buying/<layer>)
    patches.json           THE proposed core delta, grouped by owning layer
    release.json           per-layer version, hooks, frozen digest; bundle digest
    release-baseline.json  per layer, the patches in force at its last release (the additive gate)
    releases/              module release files: buying-pricing-1.1.json (npm run release:pricing)
    schemas/               generated: upstream + patches (454 schemas)
    schemas-index.json     generated: core $ids (the pinned bundle's contents)
  packages/
    core/                  @adcp/core            src/index.ts generated, no deps
    ext-rate-card-index/   @adcp-ext/rate-card-index
      extension.json  schema.json  spec.md  conformance/*.yaml  index.mjs (pinned)  package.json
      dist/bundle.json  extension.lock.json  src/index.ts  src/index.mjs  (generated)
    ext-seller-adjustable-terms/   @adcp-ext/seller-adjustable-terms  (same layout)
    acmetv-ext-daypart-codes/      @acmetv/adcp-ext-daypart-codes      (vendor namespace)
    ext-makegood-units/            @adcp-ext/makegood-units
    ext-linear-tv-indexed-cpp/     @adcp-ext/linear-tv-indexed-cpp     (pricing_model branch)
  registry/                simulated hosting: <host>/<path>/<sha256-hex>.json, and <sha256-hex>/ with the docs and code it pins
  analysis/                npm run analysis (size-comparison.json, slide-excerpts.json and .md), plus the
                           history scripts: schema-graph/, kernel-cut/, churn/, module-cut/, final/, experimental-review/
  docs-site/               generated: npm run docs (one page per extension + index.html)
  examples/
    buyer-app/             app.ts, adcp.config.json -> adcp.lock.json + adcp-sdk/ (npm run sdk; generated layer)
      adcp-sdk/            generated: bindings.ts  types.ts  index.ts  bundles/  GENERATED.json
    sales-agent/           agent.ts, adcp.config.json -> adcp.lock.json + adcp-sdk/ (npm run sdk; generated layer)
  lib/
    digest.mjs             JCS (RFC 8785) + sha256
    layout.mjs             the final layout: layer names, roles, buying's layer DAG, bridges, classifyRef()
    modules.mjs            the modules map: what an agent lists, the app's module pins, checkModules()
    additive.mjs           the additive check a module minor must pass
    core-schemas.mjs       pinned core loader, CORE_ORIGIN rule
    buyer-validator.mjs    loadModule() (digest and reference-code checks), validation, must-understand,
                           digests, negotiate(), pruneDropped()
    binding.mjs            the generated binding's runtime: decode/encode between the wire and attributes,
                           wire-location errors, wireSchema(), createBoundClient(), createBoundServer() (tenants)
    client.mjs             buyer SDK client on the wire form: requestProposals, refineProposals, acceptProposal, ...,
                           callTask(); ext(module) and `extensions` are the runtime binding
    server.mjs             seller SDK helper: dispatch (core and contributed tasks), validation,
                           get_adcp_capabilities from declarations and handlers, caller identity
    extension-spec.mjs     spec.md parser and lint; docs and reference-code hashing
    seller.mjs             projectPricingOption(), projectProduct(): omit what the buyer can't understand
    mock-seller.mjs        creator network
    mock-tv-seller.mjs     NL linear-TV sales house
  scripts/
    vendor-core.mjs  build-core.mjs  build-extensions.mjs  codegen.mjs  codegen-lib.mjs
    adcp-sdk.mjs           adcp.config.json -> adcp.lock.json + adcp-sdk/ (--check: the CI gate)
    generated-binding.mjs  the generator: walks the pinned core for hooks, writes bindings.ts, types.ts, index.ts
    layout-lint.mjs        the layout's checks on the vendored subset; blocking at zero violations
    run-conformance.mjs    storyboard runner, rule coverage, GREASE
    render-extension-docs.mjs   docs-site/ pages
    size-comparison.mjs    analysis/size-comparison.json (#8102 against the packages)
    slide-excerpts.mjs     analysis/slide-excerpts.{json,md} (hook chains from built files and a run)
    module-release.mjs     a module minor release on a scratch copy: which layers move, the additive check, apps
  fixtures/payloads.mjs    NL TV cpp option, accepted commercial_terms, capabilities
  test/
    layering.test.mjs      core never depends on extensions; delta == patches.json; hooks owned by layers;
                           layers follow the final layout file by file; star, layer, and sibling
                           checks, blocking at zero violations; the 3.4 fixes matched to the layout
    runtime.test.mjs       pass / reject / ignore cases
    scenario.test.mjs      creator scenario, compatibility, SDK assembly
    pricing-model.test.mjs a pricing model as an open-union branch
    contributed-task.test.mjs  a task an extension adds: digests unchanged, discovery, dispatch, validation
    modules.test.mjs       the modules map: schema, what the sellers emit, the client's check against the lock
    module-release.test.mjs    a buying/pricing minor moves that layer alone; the additive check refuses a required field
    generated-binding.test.mjs the generated layers: attributes, wire schema, wire-location errors, versions,
                           the pricing branch, per-tenant enablement, core unchanged when an extension is added
    apps/superset/         a test app whose layer is the superset (two versions of one uri, a pricing branch)
    apps/governance-only/  a test app that names its modules: its lock pins the kernel layer and governance only
    docs.test.mjs          docs and reference code in the digest; the loader refuses unpinned code;
                           immutability, spec lint, runner failure
    types/generated-binding.ts  compile-time checks of the generated layers
    types/usage.ts         compile-time checks of the packages and the runtime binding
```

## Output

Run the commands in [Run the example](#run-the-example); every command prints its own result. This
README records the following results:

- `npm run build`: the core patches, the frozen-digest check (every layer unchanged), the layout check
  (0 violations), the extension bundles and their digests, codegen, each app's generated layer, and a
  clean `tsc`.
- `npm test`: 91 tests pass, then `npm run conformance`: 18 of 18 storyboards and 132 of 132 steps,
  and every MUST rule has a passing storyboard.
- `npm run demo`: the installed extensions, negotiation, the rate card as an ignorable explanation, signed
  terms with two extensions, and six fail-closed cases (`EXTENSION_NOT_UNDERSTOOD`,
  `EXTENSION_VERSION_NOT_UNDERSTOOD`, `EXTENSION_DIGEST_MISMATCH`, `EXTENSION_DIGEST_DIVERGENT`, and
  `EXTENSION_DATA_INVALID`).
- `npm run release:pricing`: the module release and the refused edit; `analysis/slide-excerpts.md`
  § Module release has the output.

## Design issues found

Building the example showed what core has to change, and where the spec and the SDKs don't
line up. The following list orders these issues by how much they matter.

1. **Core must open exactly one binding point.** `commercial_terms` is closed
   (`media-buy/commercial-terms.json`, `additionalProperties: false`), and
   so is `canonical-pricing-option.json`, the accepted `purchases[].pricing`. Without
   the delta, a seller can't sign anything an extension says (test 5). Binding extension
   data therefore sits at `commercial_terms.extensions[]` and points at a purchase by
   `purchase_index`, the same pattern #8102 uses. "Keep core stable" therefore needs one small,
   one-time core change.
2. **The must-understand rule is core machinery and has to be normative.** The buyer
   rule ("reject what you don't understand at a must-understand point") and the
   point rule ("everything under `terms_digest` is must-understand") belong in core.
   The point rule lives in the annotation itself,
   `"x-adcp-extension-point": {"name": "commercial_terms", "must_understand": "always", "order": "uri"}`,
   and the validator has no list of hook names. Both annotation keywords are custom, so any
   ajv instance in strict mode has to register them.
3. **The digest rule doesn't work for embedded definitions.** "SHA-256 of the response
   body" is well-defined for a fetch, but not for a definition embedded as a JSON value
   in the `get_products` `extensions` map. Proposal: digest = SHA-256 of the JCS
   serialization, and producers serve JCS bytes. The raw-body check in both SDKs then
   keeps working (tests 6 and 27). Also, sdk-js `src/lib/v2` has the bundled
   map only in generated types, with no runtime check of the bundled entries.
4. **The `extensions` bundle map has the wrong value schema.** Its values require
   `{extends: <concept string>, fields}` (`media-buy/get-products-response.json:82-86`),
   which is designed for `platform_extensions`. A full extension bundle doesn't fit, so
   the value needs to become "a JSON Schema document". Its key pattern also allows
   `https?://`, while `platform-extension-ref.json` requires `https://`.
5. **The `$ref` sandbox blocks core references.** The fetch contract allows `$ref` only
   to resources on the same origin, to `creative.adcontextprotocol.org`, or within the
   document (`product-format-declaration.json#format_schema`; sdk-js
   `sandbox-refs.ts:160` `DEFAULT_MIRROR_HOSTS`). An extension can't reuse `Duration`
   or `FormatOptionRef` without inlining copies. Proposal, rule (d): the buyer resolves a `$ref` to
   `https://adcontextprotocol.org/schemas/...` from its pinned core
   bundle and **never fetches** it.
6. **A digest doesn't pin what the bundle references.** The digest covers the bundle
   bytes but not the core schemas they reference. If `core/duration.json` changes between
   3.3 and 3.4, the same `uri@digest` validates differently depending on the buyer's
   core pin. Two fixes are possible:
   - Reference versioned core URIs (`/schemas/3.3.0/core/...`, the `$id`s that
     `build-schemas.cjs` already stamps on versioned builds).
   - Make `requires_core` normative and resolve against exactly that version.

   The example uses unversioned URIs plus `requires_core`, which is the weaker option.
7. **The buyer needs a way to say what it understands.** The capability response
   covers the seller side (`declared_extensions`). Nothing on a request tells the
   seller what the buyer understands, so `projectPricingOption()` (drop or omit what
   the buyer can't read) takes it as a parameter. Core needs a request-side field, or
   the mirror of `adcp_version` downshifting. This is the same posture as
   `versioning.mdx:64` ("sellers project or omit").
8. **Pricing options have no shared base.** Every option file (`cpm`, `cpp`, ... `flat_rate`)
   needs its own `extensions` property, the same way #7955 adds `price_adjustments`.
   With a shared `pricing-option-base.json`, this change is one edit.
9. **`price_breakdown` limits how a card maps onto it.**
   - `rate` is capped below 1, so an index of x2 or more must be recorded as an
     `amount` (test 26). #7955 already handles this (`pricing-models.mdx:801`).
   - `price_breakdown` requires rounding at each step, so a seller that rounds only
     the final result can't produce a breakdown that satisfies the invariant exactly.
     `rounding.step: final` is in the extension's schema, but no test exercises it.
10. **SDK code generation pitfalls, all found in this example.** json-schema-to-typescript has the following problems:
    - It drops sibling `properties` when `allOf` is present (`ExtensionEntry` comes out as
      `PlatformExtensionReference`).
    - It collapses a top-level `oneOf`/`anyOf` of `required` branches, or an `allOf` of
      `if/then` blocks, to `{[k: string]: unknown}`.
    - It names a `$ref` that has sibling keywords as a separate duplicate type.
    - It generates `data: {[k: string]: unknown}`. TypeScript can't assign an interface to
      that type, so code generation must emit `object` for extension payloads.

    sdk-js already carries transforms for the first three (`resolveAllOfRefForMerge`,
    `isRequiredOnlyAnyOf`, `tightenMutualExclusionOneOf` in
    `scripts/generate-types.ts`). Extension schemas can either avoid the patterns, as
    here, or run through the same transforms. The type test catches one of these
    (`Allowance` collapsing) that the runtime tests miss.
11. **Schema-only knowledge isn't understanding.** A buyer can fetch and
    digest-verify an unknown definition and validate the data against it (test 10). Even so, a
    must-understand entry needs the extension's semantics: the evaluator and the #8102
    verifier constraints. "Understood" therefore means "the extension's code for the exact
    `uri@digest` is installed", and a known URI with a different digest isn't understood
    (`EXTENSION_VERSION_NOT_UNDERSTOOD`, test 14). A buyer can't safely
    auto-upgrade across digests unless the extension declares compatibility, which
    the example doesn't attempt.

## What changes in AdCP and in each SDK

### AdCP protocol repo (`adcontextprotocol/adcp`)

| File | Change |
|---|---|
| `static/schemas/source/core/extension-hook.json`, `extension-branch-id.json`, `extension-entry.json`, `extension-declaration.json` | Added kernel files, as in `core/patches.json`. `extension-declaration.json` carries the `task` union (`tasks[]`). |
| `static/schemas/source/core/version-envelope.json` | Add `understood_extensions[]` (issue 7). Closed requests redeclare it by `$ref`. |
| `static/schemas/source/media-buy/commercial-terms.json` | Buying declares extension point `commercial_terms` (`must_understand: always`, `order: uri`). |
| `static/schemas/source/pricing-options/*-option.json` (or an added shared base) | Buying declares extension point `pricing_option` (`flag`). |
| `static/schemas/source/core/pricing-option.json`, `canonical-pricing-option.json`, added `pricing-options/extension-option.json` | Buying opens the `pricing_model` union. |
| `static/schemas/source/media-buy/get-media-buys-response.json` | Buying declares extension point `media_buy_state` (`never`) on each media buy. |
| `static/schemas/source/media-buy/request-proposals-request.json`, `refine-proposals-request.json` | Redeclare `understood_extensions` by `$ref` (closed requests). |
| `static/schemas/source/protocol/get-adcp-capabilities-response.json` | Add `declared_extensions[]` as the kernel's fragment. Keep `extensions_supported` for `ext.{ns}`. |
| `static/schemas/source/media-buy/get-products-response.json` `extensions` | Value becomes a JSON Schema document; key `https://` only (issue 4). |
| `static/schemas/source/core/product-format-declaration.json` `format_schema` fetch contract | Digest = SHA-256 of JCS (serve JCS bytes); `$ref` rule (d) for core URIs (issues 3, 5). |
| `static/schemas/source/extensions/extension-meta.json` | It describes only `ext.{ns}`. Add the manifest fields: `extends[]` with per-point `must_understand` (and, for a task, `branch` and `response`), `requires_core`, `adopters`, `promotion`, and `docs` (`spec`, `conformance[]`, `reference_code` pins). |
| `docs/reference/schema-extensions.mdx`, `docs/reference/experimental-status.mdx`, `docs/reference/versioning.mdx` | Third lane: declared extensions, must-understand rule, promotion rule (2+ adopters / 90 days, or 1 adopter + a published market rule). |
| `static/compliance/` | One storyboard per extension, gated on `requires_capability: {path: declared_extensions, contains: ...}`. |

### sdk-js (`@adcp/sdk`)

- **`scripts/generate-types.ts`.** Add a second mode that compiles an extension bundle
  to its own package: map core-URI refs to `tsType` imports from the core types, emit
  `EXTENSION_URI`/`EXTENSION_DIGEST` consts and task descriptors, and type
  `ExtensionEntry.data` as `object` (`scripts/codegen.mjs` here is roughly that code).
  The core output (`src/lib/types/core.generated.ts`) adds only `ExtensionEntry` and
  `extensions?`.
- **An app generator: the generated binding.** A command that reads the app's `adcp.config.json`,
  resolves and locks the digests, walks the core schemas for the hooks, and writes the app's typed
  layer: the hook hosts re-pointed at one attribute per extension, a member per enabled union branch,
  a client method and a handler type per contributed task, and the wire schema
  (`scripts/adcp-sdk.mjs` and `scripts/generated-binding.mjs` here). Its small runtime maps the wire
  to attributes and back and reports errors at wire locations (`lib/binding.mjs`).
- **`src/lib/v2/format-schema/resolver.ts`.** Widen
  `CanonicalReferenceKind = 'format_schema' | 'platform_extensions'` with
  `'extension_term'`. The fetch, the digest check, and the `uri@digest` cache stay as
  they are.
- **`src/lib/v2/format-schema/sandbox-refs.ts`.** Add rule (d): resolve
  `https://adcontextprotocol.org/schemas/...` from the pinned bundle
  (`src/lib/validation/schema-loader.ts`).
- **A buyer helper.** An extension loader that runs only the reference code the digest pins, a
  must-understand check at validation, an `accept_proposal` guard (what `lib/buyer-validator.mjs`
  does), and contributed-task calls by descriptor (`callTask()`). The generated layer runs on it. Only
  runtime plug-ins need a runtime registry (`client.ext()`).
- **A seller helper.** Dispatch for core and contributed tasks, request and response
  validation, and the capabilities declaration built from what the agent declares and handles
  (what `lib/server.mjs` does).
  Register it in `validation/client-hooks.ts`.
- **`src/lib/utils/capabilities.ts:880`.** `supports('ext:<ns>')` asks what the
  *seller* declared. Add a `uri@digest` variant and the buyer-side intersection
  (`negotiate()`).

### sdk-python (`adcp`)

- **`scripts/generate_types.py` / `scripts/run_datamodel_codegen.py`.** Keep generating core
  into `src/adcp/types/`. Add an extension mode that writes a separate
  distribution and imports core models instead of regenerating them.
- **An app generator: the generated binding.** The same command as in sdk-js, emitting Pydantic:
  composed subclasses that re-point only the hook hosts at one attribute per extension, with a wrap
  validator and serializer that map the envelope, a JSON Schema override that publishes the wire
  form, and errors rewritten to wire locations.
- **`src/adcp/canonical_formats/references.py`.** `resolve_platform_extension` (:187)
  already does fetch, digest (:289), and `uri@sha256` parsing (:376). Generalize it to
  extension entries.
- **Runtime.** Response roots `forbid` unknown fields, so a 3.3-pinned client fails on
  any core field added later. The lane's purpose is that an added extension or a changed
  digest needs **no** core change: the app regenerates its own layer, and the core package and its
  `forbid` roots stay as they are. `ExtensionEntry.data` must stay `dict[str, Any]` (`extra='allow'`)
  in core.
- **`src/adcp/capabilities.py:231`.** `FeatureResolver.supports("ext:…")` gets the
  same `uri@digest` variant.

### sdk-go (`adcp/v3`)

sdk-go has only types (`PlatformExtensionRef`). It needs a port of the fetch and sandbox
logic (about 1,500 lines in JavaScript). `ComputeTermsDigest` already uses JCS over
`commercial_terms`, so the digest covers `extensions` with no further change
(an inference).

## Python layout

This example doesn't generate a Python layout. The equivalent split uses a Python Enhancement
Proposal (PEP) 420 namespace package, so each extension is its own distribution and `adcp` never
imports `adcp_ext`. The app's generated layer lives in the app, as the following tree shows:

```
adcp/                               # pip install adcp        (core, unchanged layout)
  types/_generated.py               #   ExtensionEntry, CppPricingOption, CommercialTerms, ...
  codegen/                          #   the generated binding: the app generator and its small runtime
adcp_ext/                           # namespace package: NO __init__.py
  rate_card_index/                  # pip install adcp-ext-rate-card-index
    __init__.py                     #   EXTENSION_URI, EXTENSION_DIGEST, check(), evaluate()
    types.py                        #   generated; `from adcp.types import Duration, ExtensionEntry`
    bundle.json                     #   JCS bytes, digest-verified at import
  seller_adjustable_terms/          # pip install adcp-ext-seller-adjustable-terms
acmetv_adcp_ext/daypart_codes/      # vendor namespace, its own distribution
my_agent/                           # the app
  adcp.config.json                  #   { "extensions": { "rate_card_index": "<uri>@^1" } }
  adcp_types/                       #   generated: CommercialTerms with rate_card_index: RateCardBinding | None, ...
```

The app reads `proposal.commercial_terms.rate_card_index` as a typed attribute, checked by pyright
and mypy. A runtime plug-in that loads an extension at run time can instead find installed extensions
through an entry-point group, without core knowing their names:

```toml
# adcp-ext-rate-card-index/pyproject.toml
[project.entry-points."adcp.extensions"]
rate_card_index = "adcp_ext.rate_card_index:MODULE"
```

## Hooks and pricing models

This example implements hooks and pricing models as follows:

- **The example implements two hook kinds, and tasks reuse the second.** The kinds are extension points
  (`x-adcp-extension-point`) and open unions (`x-adcp-open-union`). A contributed task is a branch
  of the kernel's `task` union. `lib/buyer-validator.mjs`, `scripts/codegen-lib.mjs` (`hookInfo()`),
  and `scripts/build-extensions.mjs` (`coreHooks()`) read the hooks from the annotations.
  None of them lists a hook name.
- **An added pricing model is a branch.** `packages/ext-linear-tv-indexed-cpp` registers
  `{ "point": "pricing_model", "branch": "indexed_cpp", "reports_as": "cpp", "applies_to": { "channels": ["linear_tv", "radio"] } }`.
  The buying module's union annotation says every branch must give `reports_as`, and the
  build enforces it. The rate per point is base × indices × a market index the seller fixes
  after booking, capped for early requests (modeled on Ster's published structure). Core `cpp` can't express this,
  because `fixed_price` binds at acceptance.
- **`lib/mock-tv-seller.mjs`** is a fictional Dutch sales house. Its linear-TV product offers
  core `cpp` at the published index (with an explanatory rate card) and the `indexed_cpp`
  branch; its online-video product is core `cpm` only. `get_products` shows these options at
  discovery; `request_proposals` returns the draft proposal and compact products. It projects
  per buyer, signs the branch into `terms_digest`, writes the fixed index as `media_buy_state`
  readback, and invoices delivered points at the fixed rate.
- **An unknown branch in a list drops only that option.** The buying module declares the
  union with `unknown_in_list: drop_option`. A buyer that doesn't understand the extension drops the indexed
  option from the product's `pricing_options`, records `EXTENSION_OPTION_DROPPED`, and keeps
  the cpp option (`pruneDropped()`; the client does it in `getProducts` and
  `requestProposals`). The client rejects a product
  whose options all drop. The pricing of a purchase in signed terms is not a list
  item, so an unknown branch there still fails closed. This answers the open question
  about how a validator treats branches in a list.
- **`test/pricing-model.test.mjs`** (11 tests) covers the open union, scoping, projection,
  the drop policy, fail closed, signed terms, settlement, the explanatory rate card, the capabilities hook,
  ordering, and the build-time registration checks. `npm run demo:pricing` prints the payloads.

## Revenue-share pricing is not a package here

Revenue-share pricing, which #6095 added to AdCP, fits a fifth worked case: a branch of
the `pricing_model` union. The example doesn't add it, for three reasons:

- **Core already has it.** The vendored closure is adcp `main` after #6095, so
  `pricing-options/revenue-share-option.json` and the closed value `revenue_share` are core. Such a
  branch duplicates a closed value of the same union.
- **Its billing basis is a metric this union can't name.** The `pricing_model` union asks each
  branch for `reports_as`, a core model whose delivery metric applies. Revenue share bills on
  `commissionable_value`, which #6095 added as a delivery metric. A faithful branch needs a
  branch contract that names a billing metric, which is a change to buying, and buying stays
  frozen in this example.
- **The rest of #6095 is outside the closure.** Its delivery, usage-reporting, and product-filter
  changes sit in schemas this example doesn't vendor, so the example can't show where they land.

## Promotion path: rate-card-index into core

The trigger is the promotion rule in the manifest: 2+ independent adopters with
substantively similar cards for 90+ days, or one adopter plus a published market
rule from a joint industry committee (JIC). This is the `format_shape` promotion rule from `format-shape-vocabulary.json:5`,
widened for small markets.

| Step | Protocol | Extension | SDKs | Wire |
|---|---|---|---|---|
| 0. Before promotion | Nothing rate-card specific | `rate-card-index@D1` | `@adcp-ext/rate-card-index@1` | `extensions[{uri, digest: D1, data}]` |
| 1. Promotion PR | Add `pricing-options/rate-card.json` = `definitions.RateCard` from D1, with core refs made relative. Add `rate_card` to the option files and to `canonical-pricing-option.json` (the accepted pricing), so the binding variant doesn't need `purchase_index`. Mark it `x-status: experimental` and `x-promoted-from: <uri>@D1`. Move the evaluator's vectors into `static/compliance/source/test-vectors/`. | Publish version 2 = D2: `status: "promoted"`, `promoted_to`, and `definitions.RateCard` becomes `{"$ref": "https://adcontextprotocol.org/schemas/pricing-options/rate-card.json"}` (an alias, not a copy). | `@adcp/core` gains `RateCard`. `@adcp-ext/rate-card-index@2` does `export type { RateCard } from '@adcp/core'` (`@deprecated`). The evaluator moves into `@adcp/sdk`. Python: `adcp_ext.rate_card_index.RateCard = adcp.types.RateCard`. | Unchanged |
| 2. Dual-ship (≥90 days) | Rule: if both are present they MUST be JCS-equal; buyers prefer the core field. | D1 and D2 both stay resolvable (immutable by digest). | Buyer validator maps `uri@D1/D2` entries to the core field. | Sellers send `rate_card` **and** the extension entry. |
| 3. Cut-over | Sellers MUST NOT emit the extension entry to callers pinned at or above the promotion release. Graduate from experimental per `experimental-status.mdx`. | Frozen. The URI and digests stay valid for earlier pins. | The extension package stays only for earlier pins. | `rate_card` only. |

**What moves:** the schema definitions, the evaluator, the vectors, and the storyboard.
**What aliases:** the URI and digests (forever, by immutability), the TypeScript type
(re-export), and the Python class (assignment).
**What doesn't change:** `extensions` itself, and every other extension.

## Creator scenario: frozen core, SDK assembly, compatibility

For the exact payloads, see `analysis/slide-excerpts.md`.

- **Frozen core, per layer.** `core/release.json` holds `adcp_version`, one entry per layer
  (role, version, the hooks it declares with their contract majors, digest), per-type majors,
  and `bundle_digest`.
  - `build-core.mjs` fails with `LAYER MOVED: <layer>` if a layer stops matching, and with
    `HOOKS DIFFER` if a layer's annotations differ from its release entry.
  - `--freeze` re-stamps the digests, which counts as a release of the layers that moved.
  - The re-stamp is gated: within a layer's major, every change since its last release must be
    additive, or `--freeze` fails with `NOT ADDITIVE` (`core/release-baseline.json` records the patches
    in force at each layer's last release). See [Module versions](#module-versions-a-minor-release-and-the-modules-map).
  - Adding an extension, or a task, moves no layer (`test/contributed-task.test.mjs`).
- **Compatibility language** (`lib/compat.mjs`). A manifest's `requires` has three parts:
  - `core`: an npm-style range, which acts as a ceiling.
  - `points`: hook majors (extension points and unions), looked up across all layers.
  - `core_types`: majors of the core types it references. The build computes these, and the digest
    covers them.

  Compatible means all three match the core release. `compat/core-releases/` holds simulated 3.4.0
  and 4.0.0 releases.
- **Registry.** `registry/<host>/<path>/index.json` maps version to digest. Versions are
  immutable. It holds `seller-adjustable-terms` 1.0.0 to 1.6.0; `makegood-units`,
  `rate-card-index`, and `linear-tv-indexed-cpp` 1.0.0 to 1.5.0; and `daypart-codes` 2.2.0 to
  2.6.0. Versions below each package's checked-in version are fixtures from `scripts/registry-history.mjs`. The
  creator seller serves `seller-adjustable-terms` 1.0.0 (no readback) next to the checked-in version.
- **SDK assembly** (`scripts/adcp-sdk.mjs`). It reads `adcp.config.json`, picks the highest
  compatible version in range, and verifies the digest. It uses an installed package if one
  claims that exact `uri@digest`. Otherwise, it generates schema-only extension code, and the lock says
  `code: "schema-only"`. It writes `adcp.lock.json` and the app's generated layer, `adcp-sdk/`
  (see [Generated binding](#generated-binding)).
- **Client** (`lib/client.mjs`, under the generated layer's `createClient()`). It handles the
  following without app code:
  - Contributed tasks: `client.requestMakegood(request)` finds the seller's transport name in
    its capabilities, validates both directions, and runs the extension's `check()`.
  - The reference-code check before the client enables an extension.
  - `understood_extensions` on requests.
  - Core and extension validation.
  - Recomputing `terms_digest` before accept.
  - `onViolation` when readback breaks the signed terms.
  - A change-feed handler.
- **Seller** (`lib/mock-seller.mjs`). An in-process creator network built on `lib/server.mjs`.
  Every request and response validates against frozen core, or, for `request_makegood`, against
  the extension's definitions. It serves registry versions loaded at run time, so it writes extension
  data with the runtime binding's writers (`commercialTermsEntry()`, `mediaBuyStateEntry()`). The
  sales agent (`examples/sales-agent/agent.ts`) is the generated-binding seller. It serves the task with a typed handler,
  projects terms per buyer, serves two versions of one extension, and announces changes on the
  core `account.change_recorded` feed.
- **Extension codegen** (`scripts/codegen-lib.mjs`). Each extension gets its types and task
  descriptors, plus the runtime binding's `read<Point>()` helpers and writers for runtime plug-ins.

## Limits of this example

- **The fetch is simulated.** `registryFetcher` reads `registry/`. The example doesn't reimplement
  the server-side request forgery (SSRF), redirect, size, timeout, and `$ref`-depth rules, because sdk-js
  `ssrf-fetch` and `sandbox-refs.ts` already cover them.
- **The capabilities closure is vendored only for validation.** Codegen covers
  pricing options, `commercial_terms`, and the added schemas, not all of core.
- **The creator scenario computes `terms_digest`** (`lib/digest.mjs` `termsDigest`, the
  SHA-256 hash of the JCS form, base64url). The fixtures in the first part don't use it.
- **Contributed tasks run in process.** The transport name stands in for an MCP tool name or an A2A
  skill name. The example doesn't model publishing the tool's input schema (MCP `tools/list`) or an A2A
  skill card from the declaration. Task results are synchronous (`status: completed`).
- **Task request and response types are a hand-written subset** (`lib/client.d.mts`).
  json-schema-to-typescript collapses the `allOf`-based task schemas (design issue 10).
- **3.4.0 and 4.0.0 are simulated release manifests.** AdCP doesn't publish per-type
  majors.
- **Arithmetic is exact-decimal (BigInt, 10^-12).** The example doesn't check it against #7955's
  1,470 lines of vectors. The rows are illustrative, based on Ster's published
  structure, not Ster's actual 2027 values.
- **Adopter names in the manifests are placeholders.**
- **The layers are the final layout as it falls on a 446-file closure.** The layout was computed at
  `ad1f380f8c`, and the vendored files come from `4f811d253e`. Every vendored path exists at both,
  and the placement is by path. Trusted-match, the compliance-testing leaf, and `buying/delivery` own
  no vendored file, and the files that the layout places in an extension stay their own `x-<name>`
  layers. The layout checks run on this subset only. The example applies the 3.4 fixes in place: a bridge
  point is an annotation on the assembled host schema, not a separate bridge package, and the core build
  inlines a composed registry. The `$id` values don't move (the layout publishes namespaced aliases in 3.4),
  and the example doesn't generate the per-layer capability fragments: `_assembly` holds the upstream files.
- **The reference-code pin covers one file.** `docs.reference_code` pins `index.mjs`, which
  imports only Node built-ins in every package here. A package whose code spans several files
  needs a pin per file, or one hash over its file list. The loader hashes the file and
  then imports it from disk; a production SDK should import the verified bytes, so nothing can swap the
  file in between.
- **The proposal flow is modeled narrowly.** `request_proposals` returns the `proposed`
  outcome only; `refine_proposals` models `finalize` of a draft only; compact products carry
  only the fields the example reads. `get_products` is discovery only, and its legacy
  `proposals` aren't modeled.
- **Size counts are lines, not effort.** #8102's tests and docs cover both its lanes, so they
  don't split by lane; `analysis/size-comparison.json` lists every file.
