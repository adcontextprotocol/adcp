# RFC: Tracker execution contracts and preview observation

Status: **Nonnormative draft for working-group discussion; not implementable authority**

Target: AdCP 3.3

Issues: #6207, #3832

Depends on: #6767 macro declarations and resolution capabilities

## Summary

This RFC separates three related claims:

1. A selected product format's `tracker_execution_contract` is the seller's
   production commitment.
2. Existing macro declarations and `macro_resolution_capabilities` define the
   exact processing semantics.
3. A preview observation session records evidence from one controlled
   execution of one preview route.

None substitutes for either of the others. Preview evidence does not prove all
production delivery, and capability matching does not prove that substitution
or tracker initiation occurred.

Every field and task proposed here applies only when the negotiated AdCP
protocol version is 3.3 or later and the exact route advertises observation.
A 3.2 or older receiver MUST NOT partially interpret these fields. A caller
MUST NOT send them merely because an older schema accepts unknown properties.

Version 1 is deliberately bounded to tracker and macro occurrences declared in
the AdCP manifest, plus macros in a URL-delivered VAST/DAAST asset's locator
URL. It does not inspect, declare, bind, or make production promises about
tracker or macro occurrences discovered inside fetched VAST/DAAST documents,
wrapper documents, JavaScript responses, or other remotely fetched bodies.
Those require a future document-site identity and provenance model.

The first version supports interactive observation only. Portable scripted
scenarios are deferred until canonical formats expose stable action identifiers;
CSS selectors, XPath expressions, screen coordinates, and provider DOM paths
are not portable protocol identity.

The end-to-end boundary is explicit:

1. discovery returns a seller-authored effective product-format contract;
2. package creation materializes an immutable snapshot of the selected format
   and execution contract;
3. preview executes one manifest against either the named discovery snapshot
   or, preferably, the package snapshot and records controlled evidence;
4. serve uses the package snapshot, not a later product mutation; and
5. reporting or attribution remains outside this RFC.

Neither a successful preview nor a digest match activates spend, approves a
creative, proves later network delivery, or changes the serving contract.

## Production tracker execution contract

### Authority and placement

Tracker support varies by product format option. Product-wide unions overstate
support when one product offers display, VAST, DAAST, and seller-rendered
options.

The binding production commitment therefore lives at
`Product.format_options[i].tracker_execution_contract`, as a sibling of
`params`. It is seller execution behavior, not a canonical format parameter.
Keeping it outside `params` also avoids requiring every digest-pinned custom
format schema to add a seller-only execution field. Publisher or placement
declarations may carry an upstream contract for seller resolution, but only the
seller-returned Product value is binding. Capability projection to
`creative.supported_formats[]` MUST strip the field. A standalone creative
capability cannot make a seller production commitment; creative agents describe
observation support on their preview route instead.

The seller resolves applicable contracts in authority order: a product cannot
broaden its publisher declaration, and a placement cannot broaden its product
option. The product's returned inline format option MUST contain the complete
effective contract used for purchase and verification; a buyer is never
required to merge an omitted or partially overlapping external contract. If
placements would produce different effective contracts, the seller publishes
distinct placement-addressable format options or the common intersection; it
does not publish their union.

Contract derivation is directional:

- when a parent contract has `complete: true`, every child selector and firing
  path MUST be a subset of the parent, and the effective child remains
  complete;
- when a parent contract is omitted or has `complete: false`, a child MAY add
  affirmative selector or firing-path knowledge because the parent's omissions
  were undeclared, not negative claims;
- an affirmative parent selector remains a commitment unless a narrower
  publisher or placement genuinely excludes the applicable inventory; and
- no layer may present a derived contract as complete unless all applicable
  parent constraints have been resolved into that one materialized effective
  contract.

The selected format option uses the existing discriminated
`format-option-ref.json` identity. Product-local options use
`{scope: "product", format_option_id}`; publisher options use
`{scope: "publisher", publisher_domain, format_option_id}`. A seller offering
production observation MUST assign a stable `format_option_id`; ID-less options
remain previewable only without `production_path` evidence.

When a package is created, each applicable
`Package.formats_to_provide[]` selected-format snapshot MUST include the full
effective `tracker_execution_contract` and sibling
`tracker_execution_contract_digest`. That digest is SHA-256 over RFC 8785
canonical JSON of the contract object alone and is immutable for the package.
Later product or publisher edits do not mutate the package snapshot.
Changing the package's selected format or tracker contract requires the
existing replacement/refinement lifecycle; it is never an in-place silent
change.
For a package relying on this contract, `formats_to_provide[]` is required even
when creative coverage is already complete; `formats_pending[]` may be empty.
This avoids a production promise that exists only in mutable discovery state.

### Contract shape

```json
{
  "tracker_execution_contract": {
    "complete": true,
    "honored": [
      {
        "selector_id": "display_impression_pixel",
        "asset_type": "pixel_tracker",
        "event": "impression",
        "method": "img",
        "execution_actor": "seller",
        "firing_paths": ["client"]
      },
      {
        "selector_id": "display_click_pixel",
        "asset_type": "pixel_tracker",
        "event": "click",
        "method": "img",
        "execution_actor": "seller",
        "firing_paths": ["client"]
      },
      {
        "selector_id": "linear_start_tracker",
        "asset_type": "vast_tracker",
        "vast_versions": ["4.2", "4.3"],
        "vast_event": "start",
        "target": "linear",
        "execution_actor": "request_executor",
        "firing_paths": ["client", "server"]
      },
      {
        "selector_id": "declared_impression_url",
        "asset_type": "url",
        "asset_group_id": "impression_tracker",
        "url_type": "tracker_pixel",
        "event_namespace": "iab_vast",
        "event_namespace_uri": "https://registry.adcp.example/iab-vast-events/sha256-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.json",
        "event_namespace_revision": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "event_name": "impression",
        "execution_actor": "request_executor",
        "firing_paths": ["client", "server"]
      }
    ]
  },
  "tracker_execution_contract_digest": "sha256:1111111111111111111111111111111111111111111111111111111111111111"
}
```

Each `honored` entry is one exact discriminated tracker/event selector. It does
not create a cross-product between asset type, event, method, target, offset,
slot, actor, or firing path. `selector_id` is unique within the materialized
contract and stable for the life of its product or package snapshot. Two
entries MUST NOT have the same structural selector identity after excluding
`selector_id`, `execution_actor`, and `firing_paths`. One structural selector
has exactly one execution actor in an effective format option, and the seller
combines all permitted firing paths into that entry. A seller that needs a
different execution actor publishes a distinct format option instead of
publishing ambiguous duplicate commitments.

`honored` means the seller MUST accept each conforming buyer-supplied manifest
tracker instance matching that selector and, for each logical occurrence of
the named event, initiate each accepted instance exactly once in total. A
tracker instance is identified by its manifest JSON Pointer and, for an array
slot, its array index. Two manifest instances with identical URLs remain two
instances and are each initiated once; implementations MUST NOT silently
deduplicate them. A repeated logical event is a new occurrence and produces a
new action per instance. Initiation means the named `execution_actor` constructs
and hands off the outbound action. It does not promise network delivery, an
HTTP success response, or attribution credit.

`firing_paths` is the complete set of environments in which that one initiation
may occur. When it contains more than one value, exactly one path is selected
for a particular logical event; it does not authorize duplicate client and
server initiation. A conforming observation records the selected `actual_path`.
A future contract that intentionally initiates the same tracker on multiple
paths requires a different explicit cardinality model and cannot use this
version's shape.

Values are `client` and `server`; there is no ambiguous `mixed` value. A buyer
requiring client-only execution matches only `firing_paths: ["client"]`.
`execution_actor` is the closed v1 subset `seller | request_executor` and is
independent of firing path: for example a `request_executor` may be a client
player or SSAI service. `buyer`, `creative_agent`, and `source_ad_server` from
the broader #6767 macro-resolver vocabulary cannot own a seller commitment to
initiate a buyer-supplied tracker in this version.

`complete: true` means unlisted combinations are explicitly unsupported.
`complete: true, honored: []` means no buyer trackers are honored. An omitted
contract or `complete: false` means omissions are undeclared, never unsupported;
listed entries remain affirmative commitments.

V1 excludes JavaScript tracker evaluation. A `pixel_tracker` or URL selector
with script execution semantics (`method: "js"` or
`url_type: "tracker_script"`) MUST NOT appear in `honored`. A later version may
define safe script-response execution and its distinct evidence boundary.

### Exact selector union

The schema is a closed `oneOf`. Every branch requires `selector_id`,
`execution_actor`, and `firing_paths`:

- `pixel_tracker` requires `event` and `method: img`. `event: custom`
  additionally requires `custom_event_name`.
- `vast_tracker` requires `vast_versions`, `vast_event`, and `target`.
  `vast_versions` is a nonempty subset of the exact VAST versions accepted by
  the selected format option. The named event/target combination MUST be valid
  in every listed version; a seller splits version-dependent behavior into
  distinct selectors or format options instead of advertising a union that is
  false for one version.
  `vast_event: progress` additionally requires `offset`. Its event restrictions
  and target/event compatibility are shared with `vast-tracker-asset.json`.
- `daast_tracker` requires `daast_versions`, `daast_event`, and `target`.
  `daast_versions` is a nonempty subset of the exact DAAST versions accepted by
  the selected format option. The named event/target combination MUST be valid
  in every listed version; version-dependent behavior is split into distinct
  selectors or format options.
  `daast_event: progress` additionally requires `offset`. Its event restrictions
  and target/event compatibility are shared with `daast-tracker-asset.json`.
- `url` requires `asset_group_id`, `url_type: tracker_pixel`,
  `event_namespace`, and `event_name`. It
  identifies an existing manifest URL slot in the selected format by
  `asset_group_id`; it does not infer an event from a URL alone.

The shared VAST target/event matrix is closed in v1: `linear` accepts
`loaded`, `start`, `firstQuartile`, `midpoint`, `thirdQuartile`, `complete`,
`mute`, `unmute`, `pause`, `resume`, `rewind`, `skip`, `playerExpand`,
`playerCollapse`, `fullscreen`, `exitFullscreen`, `progress`,
`otherAdInteraction`, `interactiveStart`, and `closeLinear`; `non_linear`
accepts `creativeView`, `acceptInvitation`, `adExpand`, `adCollapse`,
`minimize`, `overlayViewDuration`, `otherAdInteraction`, and `close`; and
`companion` accepts only `creativeView`. The shared DAAST matrix is also
closed: `linear` accepts `start`, `firstQuartile`, `midpoint`,
`thirdQuartile`, `complete`, `mute`, `unmute`, `pause`, `resume`, `rewind`,
`skip`, `progress`, `close`, and `creativeView`; `companion` accepts only
`creativeView`.
Events outside `TrackingEvents`, including impression, click, error, and
viewability-element children, are not smuggled into these branches.

Every selector is usable only when the selected format declares at least one
compatible first-class manifest slot for that asset type; the contract does not
add a slot to the format. The manifest instance must occupy such a slot and
satisfy its constraints. This means an ordinary `video_vast` option whose only
tracking is embedded in `vast_tag` cannot claim `vast_tracker` support in v1;
it must add a distinct first-class tracker slot or leave support undeclared.

The URL selector may claim only the exact event semantic declared by the
selected format's named slot under `adcp`, `iab_vast`, `iab_daast`, or a
qualified `vendor` namespace. IAB namespaces use the canonical versioned,
immutable registry artifact URI defined by AdCP for that event vocabulary; an
unversioned `latest`, branch, or generic standards landing page is invalid and
sellers cannot substitute an equivalent-looking URL. IAB and vendor namespaces
require an authority-controlled `event_namespace_uri` and immutable
`event_namespace_revision` digest, following the source-faithful macro rule.
AdCP event identity carries neither external URI nor revision.

The `.example` registry URI and digest in this draft are placeholders, not a
claim that an AdCP IAB registry already exists. WG ratification must identify
the immutable artifact registry before normative implementation; examples and
vectors then use that real pinned artifact.

A selected canonical format may use a URL selector only when its slot schema
declares the same `asset_group_id`, `asset_type: url`, allowed
`url_type: tracker_pixel`, and exact event namespace/name in a new closed
`tracker_event` object using the same namespace union. This is declarative slot
identity, not inference from a conventional group name. Today many
VAST/DAAST XML sites are not manifest slots. They remain outside v1 even if a
fetched document contains them. An implementation PR may add a distinct
manifest URL slot or dedicated first-class tracker slot; it MUST NOT claim
embedded `Impression`, `Error`, `ClickTracking`, `CustomClick`, wrapper, or
`ViewableImpression` children by name alone.

### Macro processing is not duplicated

Existing `macro_resolution_capabilities` remain authoritative for dialect,
semantic, processing operation, actor, context, and encoding depth. On a seller
production path, eligibility is the exact seller-wide ∩ package/product-format
intersection. On a standalone creative preview, eligibility comes only from
the selected `creative.supported_formats[]` route. A creative route never
borrows seller authority. `tracker_execution_contract` answers whether a
tracker is accepted and initiated; macro capabilities answer how declared
tokens are processed.

The lossy `substituted_macros_in_trackers[]` proposal is dropped. Preflight
`macro_resolution_results` retain their current compatibility meaning and are
not evidence that processing occurred.

## Preview observation capability

Each `creative.preview.routes[]` entry may advertise:

```json
{
  "observation": {
    "modes": ["interactive"],
    "captures": ["interactions", "creative_events", "outbound_actions", "macro_processing"],
    "capture_sources": [
      "controller_input",
      "renderer_event_bus",
      "macro_processor",
      "vast_player_callback",
      "network_interception"
    ],
    "execution_fidelities": ["production_path", "sandbox_equivalent", "agent_approximation"],
    "network_policy": "intercept_before_dispatch",
    "max_session_duration_seconds": 300,
    "max_log_entries": 5000,
    "macro_binding_capabilities": [
      {
        "authority": "seller_intersection",
        "dialect": "adcp",
        "dialect_semantic": "CACHEBUSTER",
        "mapping_status": "verified_universal",
        "universal_semantic": "CACHEBUSTER",
        "operation": "resolve_value",
        "performed_by": "seller",
        "supported_contexts": ["url_query_value"],
        "supported_encodings": [{ "kind": "rfc3986", "depth": 1 }]
      }
    ]
  }
}
```

Omission means the preview route does not advertise observation. Support MUST
NOT be inferred from ordinary preview support.

Each `macro_binding_capabilities[]` entry is one exact #6767 tuple plus an
`authority` discriminator. `creative_route` entries may bind only tuples
performed by the creative execution route. `seller_intersection` entries are
only a route ceiling: a production request must also find the identical tuple
in both the seller-wide and snapshotted selected-format sets. Missing namespace,
revision, semantic, operation, actor, context, or encoding equality is a
failure, never a fuzzy match. A route that accepts no synthetic values publishes
an empty array; omission leaves binding support undeclared.

`capture_sources` is the closed list of instrumentation sources the route
can expose:

- `controller_input` records user interaction delivered by the controller;
- `renderer_event_bus` records events emitted on an instrumented renderer API;
- `dom_event` records browser DOM events when the format defines them as
  meaningful;
- `vast_player_callback` and `daast_player_callback` record the applicable
  player callbacks;
- `macro_processor` records the input and exact output of the instrumented
  resolver; and
- `network_interception` records outbound actions but MUST NOT be used to
  invent an earlier creative event that was not otherwise observed.

A route cannot claim complete `creative_events` coverage for sources it does
not instrument. Vendor event-bus claims require a namespace URI and immutable
revision in the returned event.

### Fidelity

`production_path` means the identical production execution components run
through outbound-action construction, with only terminal network dispatch
replaced by observation interception. Asset access may be redirected through
the bounded preview proxy, but substituting a different renderer, macro
resolver, wrapper resolver, player callback implementation, or event bus makes
the result `sandbox_equivalent`.

Only the seller endpoint may return `production_path` by default. A different
endpoint may do so only under a seller-signed, tenant-scoped measurement
observation delegation that pins provider origin, route capability digest,
product/package and format-option scope, allowed actors/captures, and expiry.
The provider verifies that delegation on every task call. Publisher
`preview_provider` delegation grants presentation authority only and MUST NOT
be treated as measurement or seller-execution authority. Responses report
presentation and measurement authority separately.

`sandbox_equivalent` means the seller asserts functionally equivalent rendering
and macro-processing components in an isolated environment. `agent_approximation`
may be advertised and returned as useful non-verifying evidence but MUST NOT be
presented as verification of seller execution; its measurement authority is
`none`.

Fidelity is an implementation claim and evidence descriptor, not independent
certification. A delegated presentation provider alone cannot prove seller
measurement behavior.

## Preview request

### Exact product-format binding

Single preview and each batch item may request observation and name a seller
verification context:

```json
{
  "observation": {
    "mode": "interactive",
    "captures": ["interactions", "creative_events", "outbound_actions", "macro_processing"],
    "value_output": "full"
  },
  "verification_context": {
    "binding_kind": "package_snapshot",
    "package_id": "pkg_summer_carousel",
    "product_id": "acme_mobile_carousel",
    "format_option_ref": {
      "scope": "publisher",
      "format_option_id": "mobile_carousel_interstitial",
      "publisher_domain": "publisher.example"
    },
    "placement": {
      "publisher_domain": "publisher.example",
      "placement_id": "feed_interstitial"
    },
    "product_snapshot_digest": "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    "tracker_execution_contract_digest": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    "manifest_digest": "sha256:3333333333333333333333333333333333333333333333333333333333333333",
    "macro_declarations_digest": "sha256:4444444444444444444444444444444444444444444444444444444444444444",
    "route_capability_digest": "sha256:5555555555555555555555555555555555555555555555555555555555555555"
  }
}
```

`verification_context` is a `oneOf`:

- `binding_kind: product_snapshot` requires `product_id`, the existing
  `format-option-ref.json` shape, optional existing `placement-ref.json` shape,
  and the immutable product, contract, manifest, declaration, and route digests;
  or
- `binding_kind: package_snapshot` additionally requires `package_id` and binds
  to the package's materialized selected-format snapshot. Once a package exists,
  this branch is required for evidence intended to compare with serving.

New observation requests always include `publisher_domain` in `placement`; the
legacy placement-relative omission remains accepted elsewhere in 3.x but is not
exact enough for production-path evidence.

Digests use `sha256:` plus lowercase hex over RFC 8785 canonical JSON. The
manifest digest covers the exact manifest before synthetic values are applied;
the macro-declarations digest covers the ordered list of
`{asset_path, declaration}` occurrences sorted by UTF-8 JSON Pointer and then
the declaration's array index; the route capability digest covers the
advertised route, observation, and macro-binding capability objects. The
response echoes all verified digests. A digest mismatch is a typed terminal
error, never a fallback to current mutable state.

`product_snapshot_digest` covers a closed object containing `product_id`, the
selected full format declaration, effective placement reference when present,
and the tracker-contract digest. For `package_snapshot` it is the value stored
with that package snapshot, not a recomputation from the current discovery
response. Commercial fields unrelated to creative execution are intentionally
outside this digest.

For a `production_path` result, the seller MUST verify that:

1. `product_id` is visible to the authenticated account;
2. `format_option_ref` selects exactly one stable-ID option in the named
   product or package snapshot;
3. the manifest's `format_kind` and `format_option_ref`, when present, select
   the same option; and
4. `placement`, when supplied, belongs to the publisher/product scope and is
   valid for the selected option;
5. all supplied and computed digests match; and
6. the endpoint is the seller or has the exact seller-scoped measurement
   delegation described above.

Mismatch fails the request; the route MUST NOT silently downgrade or select a
different option. A non-seller creative agent omits `verification_context` and
cannot return `production_path` seller evidence.

`quality_used` remains the effective visual-quality field from preview. The
session binds and echoes it. A draft or materially approximate renderer may
still produce useful observations, but it cannot return `production_path`
unless the seller proves the exercised event, macro, and outbound-action
components are identical at that quality.

### Exact macro bindings

Existing `inputs[i].macros` remains a legacy semantic map. New observed
previews SHOULD use `inputs[i].macro_bindings[]`:

```json
{
  "name": "Synthetic unavailable-device scenario",
  "macro_bindings": [
    {
      "asset_path": "/assets/impression_tracker",
      "declaration_id": "cachebuster",
      "value": "17340001"
    },
    {
      "asset_path": "/assets/click_tracker",
      "declaration_id": "device_id",
      "availability": "unavailable"
    }
  ]
}
```

`asset_path` is an RFC 6901 JSON Pointer to the asset carrying the declaration
and is mandatory because declaration IDs are asset-local. `macro_bindings` and
legacy `macros` are mutually exclusive within one input.

Each binding is a strict `oneOf`: it contains exactly one of a string `value`
(the empty string is valid and distinct from absence) or
`availability: "unavailable"`. Supplying both or neither is invalid. Bindings
MUST NOT contain a raw value for any other availability state.

An observed request that needs exact bindings MUST supply `inputs`, even when
there is only one scenario. When `inputs` is omitted, the one implicit default
preview has no exact bindings. There is no request-level binding default that
could attach ambiguously to several variants or batch items.

Bindings are observation-only synthetic environment inputs:

- a binding is permitted only for a declared `resolve_value` occurrence;
- the selected route's `macro_binding_capabilities` MUST advertise the exact
  tuple and matching authority;
- a `production_path` seller binding additionally requires the identical tuple
  in the seller-wide ∩ snapshotted selected-format intersection;
- a standalone creative route binding uses only an exact `creative_route`
  tuple and can never yield seller production evidence;
- the harness delivers the raw binding to the actor named by the declaration;
  the caller does not become the resolver;
- `translate_to_native` and `preserve` occurrences reject bindings;
- v1 rejects a binding aimed through a `translate_to_native` declaration even
  when its target later resolves; such a binding is allowed only in a future
  version that defines an immutable processing-stage identity in the request;
- an unbound translation and later environment resolution may still be observed
  as separate stages linked by `processing_chain_id`; and
- bindings never bypass the declared operation, actor, target chain, context,
  or encoding.

Callers MUST use non-production test values. Providers cannot infer whether a
value is synthetic and therefore MUST treat every binding and resolved output
as sensitive.

`observation.value_output` is `full` or `redacted`. `full` returns exact values
and URLs only to the authenticated caller and is necessary for byte-level macro
verification. `redacted` is full-field redaction: the response and controller
MUST NOT expose raw bindings, emitted text, event values, template or expanded
URLs, query keys/values, URL origins, or token-shaped unresolved literals.
Sensitive values are replaced by provider-keyed opaque fingerprints that are
stable only within the session; the key is not disclosed and byte length is not
reported. Declaration identity and output state remain visible. Redacted output
cannot be reported as complete value verification.

### Request-mode matrix

- `single` permits one observation request and creates one session per explicit
  or implicit input.
- `batch` permits observation only on each batch item. There is no batch-level
  observation, verification-context, or macro-binding default; this prevents
  one seller/product binding from attaching to another item.
- `variant` may observe a replay only with `binding_kind: package_snapshot`, the
  historical served manifest digest, and synthetic values. Historical
  production identifiers or personal data are never imported automatically.
- Inline previews returned by `build_creative` do not create observation
  sessions in v1. A buyer follows brief → build → explicit `preview_creative`
  when event or macro evidence is required.
- `allow_async: true` may defer preview preparation, but no observation clock or
  TTL starts on the submitted response. Each session is created only in the
  terminal preview result, after the controller is ready.
- Algorithmic, conversational, and generative formats record only the concrete
  state/composition exercised in that session. Another generated combination,
  response turn, catalog item, or quality tier remains untested.

## Preview response and session placement

The returned human `renders[]` remain inert. Each
`previews[i]` corresponding to one explicit or implicit input carries its own
`observation_session`:

```json
{
  "observation_session": {
    "session_id": "obs_01J...",
    "state": "active",
    "controller_url": "https://preview.example/observations/obs_01J...",
    "execution_fidelity": "sandbox_equivalent",
    "quality_used": "production",
    "authority": {
      "presentation": { "kind": "seller" },
      "measurement": { "kind": "seller" }
    },
    "network_policy": "intercept_before_dispatch",
    "clock_origin": "execution_start",
    "expires_at": "2026-08-22T20:00:00Z",
    "evidence_binding": {
      "protocol_version": "3.3",
      "manifest_digest": "sha256:3333333333333333333333333333333333333333333333333333333333333333",
      "macro_declarations_digest": "sha256:4444444444444444444444444444444444444444444444444444444444444444",
      "route_capability_digest": "sha256:5555555555555555555555555555555555555555555555555555555555555555",
      "product_snapshot_digest": "sha256:2222222222222222222222222222222222222222222222222222222222222222",
      "tracker_execution_contract_digest": "sha256:1111111111111111111111111111111111111111111111111111111111111111"
    },
    "capture_coverage": [
      {
        "capture": "interactions",
        "status": "complete",
        "sources": ["controller_input"]
      },
      {
        "capture": "creative_events",
        "status": "partial",
        "sources": ["renderer_event_bus"],
        "limitations": ["Third-party JavaScript tracker responses are not executed"]
      },
      {
        "capture": "outbound_actions",
        "status": "complete",
        "sources": ["network_interception"]
      },
      {
        "capture": "macro_processing",
        "status": "complete",
        "sources": ["macro_processor"]
      }
    ]
  }
}
```

Batch responses use the same nesting inside each successful result's preview
variants. A requested capture has status `complete`, `partial`, or
`unsupported`; a terminal session may additionally report `truncated`.
Sources, limitations, truncation reason, and dropped-count lower bound explain
the evidence boundary.
`redacted` value output makes macro value verification at most `partial`.
Coverage in an active session is provisional even when its current status is
`complete`; only the terminal summary makes an immutable completeness claim.

`session_id` is an ID-bearing cross-task field and receives
`x-entity: preview_observation_session` everywhere it appears.

Each authority member is a discriminated object. `seller` names the
authenticated seller endpoint. A `publisher_delegate` presentation branch
pins publisher domain and delegation digest. A `seller_scoped_delegate`
measurement branch pins seller origin, delegation ID, signed-statement digest,
provider origin, route capability digest, product/package and format-option
scope, capture/actor scope, and expiry. `none` is permitted only for
non-verifying approximate evidence. Presentation authority never implies
measurement authority.

`controller_url` is an authenticated control surface for a disposable
provider-side remote browser. It is not raw executable creative HTML. It is
distinct from inert `renders[]` and from a generic `interactive_url`. The
URL contains only the non-secret session ID. An unauthenticated browser GET
enters the provider's standard interactive login/OAuth flow and then checks
tenant, account, caller, and session authorization before showing controls.
API bearer credentials are not transferred to the browser. Bearer credentials,
one-time bearer codes, reusable signing secrets, and macro values MUST NOT
appear in the URL, query, fragment, referrer, browser history, or third-party
resource request. A provider without a conforming interactive authentication
flow omits `controller_url` and cannot advertise `interactive` mode.

Human actions occur after `preview_creative` returns, so observations are
retrieved through `get_preview_observations`. The authenticated API caller ends
capture with an idempotent `finish_preview_observation` task; the authenticated
controller may expose a Finish control mapped to the same provider state
transition without reusing its browser cookie as AdCP task authorization.
Advertising any observation mode implies support for both tasks and their task
list entries. The tasks use ordinary authenticated AdCP envelopes and never
accept a controller cookie as API authorization.

Finish request:

```json
{
  "session_id": "obs_01J...",
  "drain_timeout_ms": 2000
}
```

`drain_timeout_ms` is 0–5000 and defaults to 2000. Finish atomically disables
new controller input, waits only for actions already accepted by the renderer
and interception pipeline, and then force-terminates the environment. It never
waits for external network completion. Events or actions not committed before
the bounded drain ends are not invented: affected coverage becomes
`truncated`, and the final summary reports `finish_drain_timeout` plus a lower
bound on dropped observations.

The provider reserves capacity for one terminal truncation record. Reaching
`max_log_entries` disables new input, writes that record, and performs the same
bounded finish with reason `log_limit`; it never silently overwrites or evicts
earlier sequence numbers.

Repeated finish calls return the same immutable terminal response:

```json
{
  "session_id": "obs_01J...",
  "state": "completed",
  "last_sequence": 24,
  "summary_status": "final",
  "summary_digest": "sha256:6666666666666666666666666666666666666666666666666666666666666666",
  "expires_at": "2026-08-22T20:00:00Z"
}
```

Finishing commits the terminal summary and changes `active` to `completed`. A
session that is not finished before its deadline becomes `expired`; expiry is
not reported as successful completion. Both tasks return typed
`PREVIEW_OBSERVATION_NOT_FOUND`, `PREVIEW_OBSERVATION_FORBIDDEN`,
`PREVIEW_OBSERVATION_EXPIRED`, and `PREVIEW_OBSERVATION_STATE_CONFLICT` errors
as applicable. Cross-tenant and unknown IDs both return `NOT_FOUND`;
`FORBIDDEN` is reserved for a caller known to the same tenant that lacks the
required role, so the surface does not reveal cross-tenant session existence.

## Observation stream

### Pagination and time

Request:

```json
{
  "session_id": "obs_01J...",
  "after_sequence": 18,
  "limit": 100
}
```

`after_sequence` is exclusive. Sequence numbers are immutable, strictly
increasing positive integers; gaps are permitted. `elapsed_ms` uses a monotonic
clock whose zero is the start of observed creative execution, before the first
frame and before controller input is enabled. `limit` is 1–500 and defaults to
100. `after_sequence` greater than the committed high watermark is valid and
returns an empty page without decreasing the cursor.

Response pages include:

```json
{
  "session_id": "obs_01J...",
  "state": "active",
  "page_high_watermark": 18,
  "observations": [],
  "next_after_sequence": 18,
  "has_more": false,
  "summary_status": "provisional"
}
```

`page_high_watermark` is the greatest committed sequence visible when the page
was read. `has_more` says whether additional observations at or below that
watermark remain after this page. A later poll may observe larger sequences
while the session is active. Active summaries are `provisional`; a completed
session returns one immutable `final` summary object and its digest on every
page. The response is a state-discriminated `oneOf`: `active` may carry only a
provisional summary; `completed` requires the final summary; `expired` is an
error and never a success page.

`next_after_sequence` is the greatest sequence returned on the page, or the
request's `after_sequence` when the page is empty. Clients pass it unchanged to
the next request; they do not advance directly to `page_high_watermark` while
`has_more` is true.

Observation IDs are stable. Cross-references may point forward to an
observation beyond the current page; clients preserve unresolved references and
resolve them on subsequent pages. Expired sessions return a typed
`PREVIEW_OBSERVATION_EXPIRED` error. The controller and its log expire together
in v1; no protocol log is available after `expires_at`.

A UI action such as “Clear actions” only resets the local view; it never deletes
or renumbers the protocol log.

### Interaction observation

```json
{
  "kind": "interaction",
  "observation_id": "input_17",
  "sequence": 17,
  "elapsed_ms": 8209,
  "input_source": "human",
  "interaction_name": "tap",
  "target": {
    "provider_action_id": "carousel_card_1_cta",
    "label": "Book now"
  },
  "creative_state": "card_1"
}
```

An interaction records what the controller delivered, not whether the creative
handled it. `provider_action_id` is stable only within this route/session and is
not a portable canonical action ID. Coordinates, CSS selectors, XPath, and DOM
paths MUST NOT be returned as protocol identity. `input_source` is `human` in
v1.

### Creative event observation

Standard tracker events use a discriminated `source_event` matching the tracker
asset schemas:

```json
{
  "kind": "creative_event",
  "observation_id": "ev_19",
  "sequence": 19,
  "elapsed_ms": 8214,
  "capture_source": "renderer_event_bus",
  "source_event": {
    "source_type": "vendor",
    "namespace_uri": "https://creative.example/events",
    "namespace_revision": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "event_name": "tap"
  },
  "source_asset_path": "/assets/cards/0",
  "action_label": "Open website",
  "report_label": "Card 1 clickthrough",
  "event_value": "https://voyage.example/bali",
  "creative_state": "card_1",
  "trigger_interaction_id": "input_17",
  "outbound_action_ids": ["out_20"],
  "expanded_urls": [
    {
      "outbound_action_id": "out_20",
      "url": "https://measure.example/click?cb=17340001&redir=https%3A%2F%2Fvoyage.example%2Fbali"
    }
  ]
}
```

Other `source_event` branches mirror `pixel_tracker`, `vast_tracker`,
`daast_tracker`, and format-declared URL tracker selectors. Vendor events require
the namespace URI and immutable revision shown above. Interaction triggers such
as `tap` are never silently normalized to measurement events such as `click`.

`source_asset_path` is present when an event originates in a manifest asset. A
renderer/controller event without such an asset instead requires
`renderer_source_id`; the schema requires exactly one source identity.
`capture_source` MUST be one of the route's advertised and session-reported
capture sources.

`event_value` preserves the scalar Value column exposed by event-monitor
interfaces: string, number, boolean, or null. It is not coerced into an event
name or URL. `expanded_urls[]` is a convenience projection, in outbound-action
order, of linked `tracker_request` and `navigation` actions. Each entry carries
the action ID and exact expanded URL in `full` mode, or only an opaque
session-local fingerprint in `redacted` mode. The linked outbound action is the
authoritative record; a projection mismatch is a protocol error.

In v1, `source_asset_path` and every projected URL trace only manifest assets
or locator URLs. An event discovered solely inside fetched VAST/DAAST content,
a wrapper, or executed JavaScript has no portable source identity and MUST NOT
be emitted as a contract-verifying creative event.

### Macro-processing observation

```json
{
  "kind": "macro_processing",
  "observation_id": "macro_18",
  "sequence": 18,
  "elapsed_ms": 8213,
  "processing_chain_id": "chain_click_cachebuster",
  "asset_path": "/assets/click_tracker",
  "declaration_id": "cachebuster",
  "operation": "resolve_value",
  "declared_performed_by": "seller",
  "instrumented_actor": "seller",
  "value_source": "supplied_binding",
  "declared_encoding": { "kind": "rfc3986", "depth": 1 },
  "status": "resolved",
  "output_state": "nonempty",
  "emitted_text": "17340001",
  "reason": "binding_applied"
}
```

Runtime statuses are `resolved`, `translated`, `preserved`,
`omitted_parameter`, `dialect_sentinel`, and `failed`. `output_state` is one of
`nonempty`, `empty`, `translated_token`, `preserved_literal`, `omitted`,
`sentinel`, `redacted`, or `failed`.

`emitted_text` is the exact post-encoding text inserted into the containing
field, not the raw semantic input. It is required for non-redacted `resolved`,
`translated`, `preserved`, and `dialect_sentinel` observations, and may be an
empty string only with `output_state: empty`. The caller already knows a
supplied raw value; provider-generated raw values need not be echoed.

The schema is a status-discriminated `oneOf`; fields from another branch are
forbidden:

- `resolved` requires `output_state: nonempty|empty|redacted`,
  `declared_encoding`, and `value_source`; full mode requires `emitted_text`
  and redacted mode requires `value_fingerprint`;
- `translated` requires `output_state: translated_token`, the complete emitted
  target declaration identity, and either full-mode `emitted_text` or redacted
  `value_fingerprint`; it never accepts a binding in v1;
- `preserved` requires `output_state: preserved_literal` and either full-mode
  `emitted_text` equal to the declared source token or a redacted fingerprint;
- `omitted_parameter` requires `output_state: omitted` and a structured
  `removed_occurrence` containing `asset_path`, `field`, `query_key`, and the
  zero-based key occurrence; no JSON Pointer pretends to address a substring;
- `dialect_sentinel` requires `output_state: sentinel` and either full-mode
  `emitted_text` or a redacted fingerprint; and
- `failed` requires `output_state: failed` and a structured reason.

All byte-exact strings mean the UTF-8 bytes represented by the JSON string,
without Unicode normalization. Invalid UTF-8 is not representable and fails
before observation. In redacted mode `emitted_text`, `event_value`, URL fields,
and unresolved literal tokens are forbidden rather than merely optional.

`reason` uses a closed enum in v1: `binding_applied`,
`environment_value_applied`, `translated_to_target`,
`preserved_by_declaration`, `unavailable_parameter_omitted`,
`unavailable_sentinel_emitted`, `value_unavailable`, `capability_mismatch`,
`actor_error`, `encoding_error`, or `policy_blocked`. New reasons are additive
only in a later protocol version; free text belongs in an optional `message`.

`instrumented_actor` equals `declared_performed_by` for `production_path`.
When a sandbox harness simulates the actor, the fidelity is
`sandbox_equivalent` and the distinct component identity is reported.

A translation and later resolution have separate observations sharing
`processing_chain_id`. A binding may attach only to the latter
`resolve_value` occurrence when that occurrence was already manifest-declared;
v1 has no request identity for a resolution stage materialized only after a
translation.

### Outbound-action observation

```json
{
  "kind": "outbound_action",
  "observation_id": "out_20",
  "sequence": 20,
  "elapsed_ms": 8215,
  "action_type": "tracker_request",
  "method": "GET",
  "execution_actor": "seller",
  "actual_path": "client",
  "source_event_id": "ev_19",
  "tracker_source": {
    "kind": "manifest_asset",
    "asset_path": "/assets/click_tracker"
  },
  "matched_contract_selector": {
    "selector_id": "display_click_pixel",
    "tracker_execution_contract_digest": "sha256:1111111111111111111111111111111111111111111111111111111111111111"
  },
  "cardinality": {
    "logical_event_occurrence_id": "ev_19",
    "tracker_instance_path": "/assets/click_tracker",
    "initiation_ordinal": 1
  },
  "template_url": "https://measure.example/click?cb={CACHEBUSTER}&redir=https%3A%2F%2Fvoyage.example%2Fbali",
  "resolved_url": "https://measure.example/click?cb=17340001&redir=https%3A%2F%2Fvoyage.example%2Fbali",
  "disposition": "intercepted",
  "macro_observation_ids": ["macro_18"]
}
```

The example assumes a matching `{CACHEBUSTER}` macro declaration and exact
route capability. One entry represents one URL and one manifest tracker
instance. An event associated with three tracker instances references three
outbound actions, even when two URLs are byte-identical.

`action_type` is `tracker_request`, `navigation`, or `resource_request`.
Typed render assets fetched through the safe proxy are `resource_request` and
are never mislabeled as trackers. Observation mode reports `intercepted` or
`blocked`; it MUST NOT claim a request completed or fired when dispatch was
suppressed. `resolved_url` is the definitive full, post-processing URL when
`value_output: full`; redacted output includes only an opaque session-local
fingerprint and marks URL-value verification partial.

`actual_path` is required for `tracker_request`, where it MUST be one of the
matched contract selector's `firing_paths`. It is optional and informational
for navigation and resource requests, which are outside the tracker execution
commitment.

Every `tracker_request` requires `execution_actor`, `tracker_source`,
`matched_contract_selector`, and `cardinality`. V1 `tracker_source` is a
`manifest_asset` object carrying the exact JSON Pointer of a first-class
tracker or declared tracker-URL slot. A VAST/DAAST locator is a resource
request, not a tracker source; its macros may be observed, but it cannot match a
tracker selector. There is no embedded-document branch.
`matched_contract_selector` pins both `selector_id` and
`tracker_execution_contract_digest`. `initiation_ordinal` MUST equal 1; a second
action with the same `{logical_event_occurrence_id, tracker_instance_path}` is
an exactly-once violation, not ordinal 2. Repeated logical events have distinct
event occurrence IDs.

For `production_path`, outbound `execution_actor` equals the matched selector's
actor and the actual instrumented component identity. A delegated provider
reports both the actor and delegate component; it cannot relabel itself as the
seller.

A tracker action can satisfy exactly-once evidence only when
`source_event_id` resolves to an observed logical event and the tracker source
resolves to one manifest instance. An intercepted but uncorrelated request is
still logged, with a structured runtime error, but its cardinality result is
`indeterminate`.

Navigation and resource actions forbid tracker-source and matched-selector
fields. Redacted mode replaces both template and resolved URLs with opaque
session fingerprints and forbids URL origin, path, query, and fragment
projections.

### Runtime error and summary

Runtime failures are ordered `runtime_error` observations with a typed code,
source identity, and message. A completed page carries a structured final
summary:

```json
{
  "summary": {
    "summary_status": "final",
    "last_sequence": 24,
    "counts": {
      "interactions": 1,
      "creative_events": 1,
      "tracker_requests": 1,
      "navigations": 0,
      "blocked_actions": 0
    },
    "tracker_instance_results": [
      {
        "tracker_instance_path": "/assets/click_tracker",
        "selector_id": "display_click_pixel",
        "logical_event_occurrences": 1,
        "initiations": 1,
        "exactly_once_status": "satisfied"
      }
    ],
    "macro_results": {
      "exercised": 1,
      "unexercised": 0,
      "empty_substitutions": [],
      "unresolved_literals": []
    },
    "truncation": {
      "occurred": false,
      "reason": null,
      "dropped_observations_lower_bound": 0
    },
    "summary_digest": "sha256:6666666666666666666666666666666666666666666666666666666666666666"
  }
}
```

The terminal summary also includes:

- counts by interaction, exact source event, outbound action, disposition, and
  actual firing path;
- exercised and unexercised macro declarations;
- `empty_substitutions[]`, each correlated by asset path and declaration ID;
- `unresolved_literals[]`, each carrying asset path and byte-exact token, plus
  declaration ID when the occurrence was declared (legacy or unrecognized
  token-shaped text may have no declaration) in full mode, or an opaque
  session-local fingerprint without token text in redacted mode;
- redactions;
- per-capture completeness, sources, and limitations; and
- wrapper/player rendering coverage and explicit v1 verification exclusions
  where applicable.

`summary_digest` is computed over RFC 8785 canonical JSON of the summary without
the digest field. `exactly_once_status` is `satisfied`, `violated`, or
`indeterminate`; incomplete or truncated action/event coverage can only produce
`indeterminate`, never `satisfied`. Redacted summaries use identities, states,
counts, and opaque fingerprints only.

Zero observed logical occurrences for the selector's event is
`indeterminate`, never vacuously `satisfied`. Only an `intercepted` tracker
action whose outbound request was fully constructed counts as an initiation;
a policy-`blocked` action is evidence of non-initiation and cannot satisfy the
exactly-once contract.

Absence of an observation never proves lack of support in interactive v1.
Interactive evidence lets a buyer inspect repetitions and timing relative to
recorded human input; it does not assert that an unperformed scenario would
have produced or omitted an event.

## Security and privacy

- Execute in a fresh provider-side browser or worker with no ambient
  credentials, cookies, local storage, private-network access, popups,
  downloads, or unrestricted redirects.
- Intercept or deny every network-capable primitive before external DNS or
  socket dispatch, including `fetch`, XHR, `sendBeacon`, image/script/style/font
  and media loads, forms, navigations, WebSocket, EventSource, VAST/DAAST
  wrappers, and redirects.
- Fetch typed render assets and explicitly supported VAST/DAAST wrapper
  resources only through the existing public-IP, DNS-pinned, no-redirect,
  bounded proxy. Wrapper resolution has strict depth, byte, request, and time
  limits. In v1 this may make a visual/player preview useful, but occurrences
  discovered in wrapper or inline XML do not enter tracker-contract or macro
  verification. Coverage states that limitation explicitly.
- Never execute a fetched `pixel_tracker` JavaScript response. Log the
  intercepted include as a non-verifying blocked action. V1 contracts cannot
  honor JavaScript tracker execution, and events that could be produced only by
  that response are unobserved.
- Apply strict CPU, memory, time, request-count, response-size, and log-size
  limits.
- Scope sessions and logs to the authenticated tenant, account, and caller; use
  short TTLs and do not place bearer secrets in URLs.
- Treat all macro bindings, emitted text, and resolved URLs as sensitive.
  Redaction covers event values, all URL components, unresolved literals, and
  controller projections as well as macro fields, and is never presented as
  full value verification.
- Observation proves one controlled scenario on one named route, exact format
  option, and fidelity. It is evidence, not a universal production guarantee.

The existing empty-sandbox rule for inert `PreviewRender` remains unchanged.
Executable creative code runs only in the provider-side disposable environment,
not in the consumer's preview iframe or host DOM.

## Proposed decision memo for working-group review

This section is a nonnormative proposal, not a decision record and not suitable
for `governance/decisions/` before human ratification.

**Proposed decision:** Ordinary serve-time macro substitution remains outside
AdCP wire observation. An explicitly advertised, requested, identity-bound
preview-observation session may serialize controlled Live Integration evidence
for its named actor, route, product/package snapshot, scenario, and capture
boundary. Preflight `macro_resolution_results` remain compatibility results,
not runtime proof.

**Relationship to DR-0005:** If ratified, the new record should fully supersede
DR-0005, restate DR-0005's ordinary-task rule, and add this narrow exception.
The old record should be marked `superseded_by` the new record. The governance
format has no `proposed` status or partial-supersession syntax, so this draft
does neither.

Storyboard conformance continues to test request/response shape, capability
matching, and deterministic golden fixtures. Live Integration fixtures test
observation behavior. Existing dormant substitution-observer fixtures are
migrated to these tasks or removed; no parallel observer model remains.

## Deferred from #6207

- `impression_id.minted_by` is dropped. Minting is a per-impression runtime
  choice. A later RFC may declare honest `possible_sources[]` if discovery is
  required.
- Delivery/log availability moves to a later
  `reporting_capabilities.delivery_data_exports[]` RFC.
- `{TMPX}` is not a publisher log-export key; TMP requires publishers to carry
  it opaquely without parsing or logging it.
- `supported_attribution_methodologies` is split out because seller ad-server
  acceptance and measurement-vendor methodology have different capability
  owners.
- Portable scripted observation is deferred until canonical formats define
  stable action identifiers and scenario-step semantics.

## Conformance plan

Schema and golden-vector tests cover:

- every exact tracker selector branch, including URL-slot selectors;
- custom/progress conditional requirements and forbidden VAST/DAAST event
  combinations;
- parent-complete subset, parent-undeclared affirmative refinement, semantic
  selector uniqueness, firing-path subset, per-instance exactly-once, and
  package snapshot semantics;
- exact existing format-option/placement references and immutable manifest,
  declaration, capability, product/package, and contract digests;
- macro-binding eligibility, actor ownership, translation-chain linkage,
  seller-intersection versus creative-route authority, strict value/availability
  `oneOf`, encoding, empty values, preserved literals, omission, sentinels, and
  full redaction;
- every observation union arm;
- monotonic ordering, forward references, pagination, terminal summaries,
  idempotent bounded finish/drain, truncation, session expiry, and log TTL;
- presentation versus measurement authority and seller-scoped delegation; and
- capture-source and structured-coverage claims, including v1 exclusions for
  fetched document contents and JavaScript evaluation.

Live Integration vectors cover manifest-declared intercepted impression,
click, VAST-tracker, and DAAST-tracker events; locator-URL macros; recorded user
input; repeated events with distinct sequence and timing; exact tracker source,
selector, actor, and actual-path reporting; exact macro encoding; empty,
unavailable, translated, preserved, omitted, and sentinel outputs;
event-monitor-style values and expanded-URL projections; blocked navigation;
JavaScript and embedded-document exclusions; bounded wrapper rendering without
verification claims; drain truncation; and terminal capture summaries.

Production-path claims additionally prove binding to the selected seller
product format and equality of the instrumented and declared responsible actor.

## Versioning

If ratified, this is additive AdCP 3.3 work. Until then, this document is a
nonnormative design draft and no producer may claim conformance to it. All use
is gated by negotiated protocol version, explicit product-format and
preview-route capabilities, and the authority rules above. Omission means
undeclared or unsupported only where expressly stated; no 3.2 or
maintenance-line backport is proposed. A later normative implementation PR
requires a minor changeset; this discussion-only draft does not ship schemas
and therefore carries no release changeset.
