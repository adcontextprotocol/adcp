# Proposal: TMP as Core Prebid Infrastructure

## Problem

Prebid has 61 RTD (Real-Time Data) modules. Each one follows the same pattern:
fetch external data, enrich bid requests and/or set ad server targeting. Each
vendor ships its own module with its own API format, configuration, and
maintenance burden.

### What RTD modules actually do

RTD modules hook into the auction via `getBidRequestData` (modify bid requests
to bidders) and `getTargetingData` (set ad server key-values). They fall into
five categories:

| Category | Count | What they do | Examples |
|---|---|---|---|
| **Contextual/content** | 13 | Classify page content, return topics/keywords/safety scores | IAS, Browsi, DG Keywords, Qortex, Relevad |
| **Audience/identity** | 18 | Append user segments, cohorts, or identity data to bid requests | Permutive, Sirdata, Experian, LiveIntent, 1plusX, BlueConic |
| **Brand safety** | 8 | Monitor or verify ad/creative safety | Confiant, GeoEdge, Clean.io, Human Security |
| **Bid enrichment** | 7 | Modify bid structure, floors, or filtering | PubXai (floors), Greenbids (bid shaping), Hadron |
| **Other** | 15 | Device detection, video context, timeout control, measurement | 51Degrees, WURFL, JW Player, Chrome AI Topics |

### What they send

Most RTD modules send some combination of: full page URL, referrer, viewport
dimensions, ad unit structure (bidders, sizes, params), existing user eIDs, and
consent strings. Many send the complete OpenRTB BidRequest (2-10KB). The vendor
API returns data that gets injected into:

- `ortb2.user.data` — user segments sent to all bidders
- `ortb2.site.ext` — site-level extensions
- `ortb2Imp.ext` — per-impression extensions
- Per-bidder `ortb2Fragments` — bidder-specific targeting
- Ad server targeting — GAM key-values

### The problems

- **61 modules, same pattern.** Each is a separate integration with its own
  configuration, testing, and Prebid PR cycle. New vendors require new modules.
- **Large payloads.** Sending the full BidRequest (2-10KB) when most modules
  only need page context and ad unit codes.
- **No privacy separation.** User identity and page context travel in the same
  request. Privacy depends on field-level masking — one missed field leaks data.
- **No standard protocol.** Vendors define their own request/response formats.
  Switching vendors means rewriting the integration.

### What TMP can replace

Of the 61 modules, approximately 38 (contextual + audience + brand safety + bid
enrichment) follow the "fetch data, enrich request" pattern that TMP
standardizes. Specifically:

| TMP operation | Replaces | How |
|---|---|---|
| **Context Match** | Contextual modules (IAS scores, Browsi predictions, keyword extraction, content classification) | Page context in, targeting signals out. Same data, standard format. |
| **Identity Match** | Audience modules (Permutive cohorts, Sirdata segments, Experian RTID, LiveIntent segments) | Opaque user token in, per-package eligibility out. Segments flow as signals. |
| **Both** | Hybrid modules (Sirdata, 1plusX, Optable) that do contextual + audience enrichment | Two operations, structurally separated. |

Modules that TMP does **not** replace: real-time security monitoring (Confiant,
Human Security), client-side device detection (51Degrees, WURFL), auction
timeout control, and proprietary client-side engines that require their own
JavaScript runtime.

## Proposal

Make TMP (Trusted Match Protocol) a core Prebid capability — configured via
`pbjs.setConfig()` in Prebid.js and via YAML in Prebid Server. Publishers
register TMP providers the same way they register bidder adapters: declare them,
configure endpoints, done.

TMP is an open protocol (part of AdCP) that standardizes what RTD modules do
today. It defines two operations:

- **Context Match**: page context in, offers + targeting signals out. No user data.
- **Identity Match**: opaque user token in, per-package eligibility out. No page data.

The publisher joins the results locally. The buyer never sees both context and
identity for the same impression.

## What changes in Prebid.js

### Configuration

```javascript
pbjs.setConfig({
  tmp: {
    router: 'https://tmp.publisher.example.com',
    propertyRid: '01916f3a-9c4e-7000-8000-000000000010',
    propertyType: 'website',
    identity: {
      tokenSource: 'uid2',        // reads from existing UID2 module
      allPackageIds: [             // ALL active packages across all buyers
        'pkg-display-0041', 'pkg-display-0042', 'pkg-native-0078',
        'pkg-video-0201', 'pkg-display-0103'
      ]
    },
    temporalDelay: { min: 100, max: 2000 },  // ms, randomized
    timeout: 50                               // ms, context match timeout
  }
});
```

No module installation. No `pbjs.que.push`. Just config.

### Per-ad-unit configuration

```javascript
var adUnits = [{
  code: 'article-sidebar',
  mediaTypes: { banner: { sizes: [[300, 250]] } },
  tmp: {
    placementId: 'article-sidebar-300x250',
    artifacts: [{ type: 'url', value: window.location.href }]
  },
  bids: [/* existing bidders */]
}];
```

### What Prebid.js does internally

1. **On auction init**: For each ad unit with `tmp` config, call
   `buildContextMatchRequest()` from `@adcp/client/tmp` and send to the router.
2. **On context match response**: Store offers and signals per ad unit.
3. **After temporal delay** (randomized): Call `buildIdentityMatchRequest()` with
   the user's token (from existing identity module) and ALL active package IDs.
   Send to the router.
4. **On identity match response**: Call `joinResults()` to intersect offers with
   eligibility. Call `toTargetingKVs()` to flatten to key-values.
5. **Set targeting**: Apply key-values to the ad unit before bid requests go out.
   GAM line items match on `adcp_pkg` and `adcp_seg`. Signals also flow to
   bidders via `ortb2.site.ext` and `ortb2.user.data` — the same injection
   points RTD modules use today. Bidders see enriched bid requests without
   needing to know TMP exists.

The `@adcp/client/tmp` package handles steps 1, 3, and 4 as pure functions. Prebid
handles the HTTP calls, timing, and ad unit targeting — exactly what Prebid is
good at.

### Dependency: `@adcp/client/tmp`

- Zero dependencies, under 3KB gzipped
- Tree-shakeable — only the functions Prebid uses get bundled
- Types + pure functions — no network calls, no side effects
- Prebid already supports npm dependencies for core modules
- Ed25519 request signing is handled by `@adcp/client/tmp` when a signing
  key is configured (see [Request signing](#request-signing) below for the
  requirements that apply to both Prebid.js and PBS)

## What changes in Prebid Server

### YAML configuration

```yaml
tmp:
  signing:
    # Path to the publisher's Ed25519 private key. Prefer an HSM or KMS
    # reference over a file mount — see "Signing key storage" below.
    key_ref: "kms://projects/pub-1/locations/global/keyRings/tmp/cryptoKeys/signing"
    key_id: "pub-1-2026q2"
  providers:
    - agent_url: "https://scope3.example.com"
      endpoint: "https://scope3.example.com/tmp"
      context_match: true
      identity_match: true
      timeout_ms: 50
    - agent_url: "https://doubleverify.example.com"
      endpoint: "https://dv.example.com/tmp"
      context_match: true
      identity_match: false
      timeout_ms: 30
```

### What Prebid Server does internally

Uses `adcp-go/tmp/client` for:
- Fan-out to configured providers in parallel over HTTP/2
- Per-provider timeouts with graceful degradation
- Response merging (offers concatenated, signals merged, eligibility conservative-merged)
- Ed25519 request signing (see [Request signing](#request-signing) below)

Prebid Server handles the integration with existing modules. TMP runs at the
`processed-auction-request` hook stage — after imps are parsed and before bid
requests are dispatched — so the module can read per-imp `tmp` ext and set
targeting key-values without racing bidder fan-out.

### Temporal decorrelation in a server-side embed

The [spec](/docs/trusted-match/specification#temporal-decorrelation) requires
a random 100-2000ms delay between Context Match and Identity Match. The threat
model is a **buyer agent or network observer between router and buyer**
correlating a Context Match for a placement with an Identity Match for the
same user by seeing the two arrive within microseconds of each other. The
delay breaks that timing link; package-set decorrelation and structural
separation (already handled by the router) are complementary but do not
substitute for it.

In a browser-side Prebid.js integration, the delay is cheap — Identity Match
runs asynchronously after context results are applied, off the auction
critical path. In a server-side embed, holding the auction for 100-2000ms is
not an option. Implementations decorrelate without blocking the auction using
one or more of the following:

- **Identity caching across page views.** Cache Identity Match responses per
  user token for the buyer's `ttl_sec` (typically 60s+). Cache hits reuse
  eligibility without firing a request, so the correlatable pair doesn't
  exist on those auctions. **Cache misses still produce a correlatable pair
  if fired in parallel** — the first page view of every new `user_token` is
  fully exposed. Operators applying this strategy MUST still introduce a
  randomized delay on cache-miss Identity Match, or combine caching with the
  hybrid or out-of-band options below. Each cache refresh MUST generate a new
  Identity Match `request_id` — reusing the cached response's `request_id` on
  a new wire send violates the spec's per-epoch dedup requirement.
- **Hybrid client/server split.** Run Context Match server-side in PBS, fire
  Identity Match from a Prebid.js companion after a randomized post-auction
  delay. The decorrelation comes from the randomized delay, not from
  origination source — the router still emits to the buyer from its own egress
  IP in both cases. This option defeats client-IP correlation at the publisher
  edge but relies on the post-auction delay to defeat router-to-buyer timing
  correlation.
- **Out-of-band batched identity.** Issue Identity Match on a background
  trigger (page-load-complete, visibility change, idle callback) independent
  of the auction. The trigger alone is not sufficient — `visibilitychange`
  and page-load-complete are observable via adjacent pixel fires, so the
  background path MUST still add a uniformly-distributed 100-2000ms delay
  after the trigger event, and SHOULD batch across multiple page views where
  feasible. This typically requires a sidecar service or a Prebid.js
  companion; PBS modules are request-scoped and don't natively host
  background schedulers.

Pure server-side parallel execution at the start of the auction is the
easiest to implement but does not satisfy the spec's temporal decorrelation
SHOULD — the two requests arrive at buyer agents within microseconds of each
other, which is exactly the pattern the SHOULD exists to prevent. Publishers
accepting this trade-off should surface it in a public manifest (e.g.,
alongside `adagents.json`) so auditors and users can see which publishers
have opted out.

### Request signing

Per the spec's [Request Authentication](/docs/trusted-match/specification#request-authentication)
model, the router signs all TMP requests — Context Match and Identity Match —
with Ed25519. Providers verify signatures using the publisher's public key
from the property registry. Providers typically sample-verify (e.g., 5% of
requests) rather than verify every request to keep per-request cost under
30µs; sustained failures trigger property suppression. This prevents
unauthorized parties from probing provider targeting logic by forging
requests.

Implementations using `adcp-go/tmp/client` inherit outbound signing — the
client loads the publisher's signing key at startup and signs every request.
Verification cost sits on the provider side and isn't affected. Implementations
building against the TMP schemas directly without the SDK must implement:

- `X-AdCP-Signature` and `X-AdCP-Key-Id` headers on every request.
- Daily-epoch replay window (`floor(unix_timestamp / 86400)`); see the
  [signature envelope](/docs/trusted-match/specification#signature-envelope)
  for per-message-type signed-field ordering.
- Signature invalidation on active-package-set change. Context Match
  signatures cover the sorted `package_ids` list; when the buyer's active set
  changes, cached per-placement signatures must be regenerated. Daily-epoch
  rollover alone isn't sufficient.
- [Key rotation](/docs/trusted-match/specification#key-rotation) via
  `agent-signing-key.json`; providers cache keys with a 5-minute TTL.

**Operator guidance for the PBS embed:**

- **Signing key storage.** The publisher's Ed25519 private key is high-value
  material — it authorizes forged Context Match and Identity Match requests
  against every provider in the registry for the entire daily epoch if leaked.
  Store in HSM or KMS, not a mounted file. The spec's current key model
  supports rotation (5-minute TTL on cached public keys) but has no
  revocation path; a leaked key's blast radius extends up to the
  ~48-hour replay window until the daily-epoch rotates it out.
- **End-to-end signing verification before go-live.** Per spec
  [§Signature verification](/docs/trusted-match/specification#signature-verification),
  providers SHOULD suppress a property for 24 hours on verification failure.
  Misconfigured signing is silent-then-catastrophic — run a signed probe
  against at least one provider before flipping traffic.
- **401 handling.** Treat signature verification failures as non-retryable;
  exclude the provider from the current auction and alert operations.
  Sustained failures indicate key rotation drift or clock skew across the
  epoch boundary.
- **Cross-provider replay surface.** Context Match signed fields don't
  include a provider audience, so a captured signature is valid against every
  provider in the registry within the epoch. Treat Context Match signatures
  as bearer tokens across the registry, not as per-provider credentials. A
  [follow-up spec issue](#) is open to add provider binding.

### Dependency: `adcp-go/tmp`

- Standard Go module, no CGO
- HTTP/2 client with connection pooling (stdlib `net/http`)
- Ed25519 signing (stdlib `crypto/ed25519`)
- No external dependencies beyond Go stdlib

## Migration from Scope3 RTD module

Scope3 is the first TMP provider. Migration for publishers currently using the
Scope3 RTD module:

### Step 1: Scope3 exposes TMP endpoint

Scope3 adds a TMP-compatible endpoint alongside their existing RTD API. The
endpoint accepts `ContextMatchRequest` and returns `ContextMatchResponse`.
Scope3's existing contextual targeting, content classification, and enrichment
signals map directly to TMP offers and signals.

### Step 2: Publisher switches config

Before (Scope3 RTD module):
```javascript
pbjs.setConfig({
  realTimeData: {
    dataProviders: [{
      name: 'scope3',
      params: {
        publisherId: 'pub-12345'
      }
    }]
  }
});
```

After (TMP core):
```javascript
pbjs.setConfig({
  tmp: {
    router: 'https://tmp.publisher.example.com',
    propertyRid: '01916f3a-9c4e-7000-8000-000000000010',
    propertyType: 'website',
    timeout: 50
  }
});
```

The publisher's router configuration includes Scope3 as a provider. No
per-vendor module needed.

### Step 3: Deprecate Scope3 RTD module

Once publishers have migrated, the vendor-specific module can be deprecated.
Other vendors (DoubleVerify, IAS, etc.) can expose TMP endpoints and join the
same config — no new Prebid modules needed.

## Benefits for Prebid

### Fewer modules to maintain

One TMP adapter in Prebid core replaces up to 38 vendor RTD modules (the
contextual, audience, brand safety, and bid enrichment categories). Each vendor
becomes a provider endpoint in config. New vendors don't require new Prebid
modules, PRs, or releases.

### Smaller payloads

| | RTD module (today) | TMP |
|---|---|---|
| Request size | 2-10KB (full BidRequest) | 200-600 bytes |
| What's sent | Everything OpenRTB has | Only page context |
| User data in request | Yes (masked) | No (structural separation) |

### Privacy by design

RTD modules send user identity and page context in the same request. Privacy
depends on field-level masking — one missed field leaks data.

TMP separates context and identity into different requests on different code
paths. The context path never has access to identity data. This is structural,
not policy-based. TEE attestation can make it independently verifiable.

### Open provider ecosystem

Any company can become a TMP provider by exposing a standard HTTP/2 endpoint.
No Prebid module PR needed. No vendor-specific configuration format. Publishers
add providers in config the same way they add bidder adapters.

### Aligns with Prebid's direction

Prebid already standardized demand (bidder adapters) and identity (userId
modules). TMP standardizes the remaining piece: real-time contextual and
identity-based enrichment. The pattern is the same: define a protocol, let
vendors implement it, publishers configure endpoints.

## Reference adapter: Prebid.js

This is a starting point for the Prebid team to adapt to Prebid.js internals.
It uses `@adcp/client/tmp` for data transformation and Prebid's hooks for
lifecycle integration.

```javascript
import {
  buildContextMatchRequest,
  buildIdentityMatchRequest,
  joinResults,
  toTargetingKVs,
} from '@adcp/client/tmp';

// Register as a Prebid subsystem
function init(config, userConsent) {
  const { router, propertyRid, propertyType, identity, temporalDelay, timeout } = config.tmp;

  // Hook into auction lifecycle
  getGlobal().requestBids.before(function(next, bidRequestConfig) {
    const adUnits = bidRequestConfig.adUnits || getGlobal().adUnits;
    const tmpUnits = adUnits.filter(u => u.tmp);

    if (!tmpUnits.length) return next.call(this, bidRequestConfig);

    // Phase 1: Context Match (all units in parallel)
    const contextPromises = tmpUnits.map(unit => {
      const req = buildContextMatchRequest({
        propertyRid,
        propertyType,
        placementId: unit.tmp.placementId,
        artifacts: unit.tmp.artifacts,
        contextSignals: unit.tmp.contextSignals,
        geo: unit.tmp.geo,
      });

      return fetchWithTimeout(router + '/context', req, timeout)
        .then(res => ({ unit, req, res }))
        .catch(() => ({ unit, req, res: null }));
    });

    Promise.all(contextPromises).then(contextResults => {
      // Store context results
      const contextMap = new Map();
      for (const { unit, res } of contextResults) {
        if (res) contextMap.set(unit.code, res);
      }

      // Phase 2: Identity Match (after temporal delay)
      if (identity?.tokenSource) {
        const delay = randomBetween(temporalDelay.min, temporalDelay.max);

        setTimeout(() => {
          const userToken = getUserToken(identity.tokenSource);
          if (!userToken) return applyContextOnly(contextMap, tmpUnits, next, bidRequestConfig);

          const idReq = buildIdentityMatchRequest({
            userToken: userToken.value,
            uidType: userToken.type,
            packageIds: identity.allPackageIds,
            consent: buildConsent(userConsent),
          });

          fetchWithTimeout(router + '/identity', idReq, timeout)
            .then(idRes => {
              // Join and apply targeting
              for (const unit of tmpUnits) {
                const contextRes = contextMap.get(unit.code);
                if (!contextRes) continue;

                const result = joinResults(contextRes, idRes);
                const kvs = toTargetingKVs(result);
                setTargetingForAdUnit(unit.code, kvs);
              }
              next.call(this, bidRequestConfig);
            })
            .catch(() => {
              applyContextOnly(contextMap, tmpUnits, next, bidRequestConfig);
            });
        }, delay);
      } else {
        applyContextOnly(contextMap, tmpUnits, next, bidRequestConfig);
      }
    });
  });
}

// Context-only fallback (no identity match)
function applyContextOnly(contextMap, tmpUnits, next, bidRequestConfig) {
  for (const unit of tmpUnits) {
    const contextRes = contextMap.get(unit.code);
    if (!contextRes) continue;

    // Without identity, activate all offered packages
    const kvs = {};
    kvs.adcp_pkg = contextRes.offers.map(o => o.package_id);
    if (contextRes.signals?.segments) kvs.adcp_seg = contextRes.signals.segments;
    if (contextRes.signals?.targeting_kvs) {
      for (const kv of contextRes.signals.targeting_kvs) {
        kvs[kv.key] = kvs[kv.key] || [];
        kvs[kv.key].push(kv.value);
      }
    }
    setTargetingForAdUnit(unit.code, kvs);
  }
  next.call(this, bidRequestConfig);
}

// Helpers
function fetchWithTimeout(url, body, timeoutMs) {
  return Promise.race([
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => r.json()),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
  ]);
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
```

## Reference adapter: Prebid Server (Go)

```go
package tmp_module

import (
    "context"
    "time"

    "github.com/adcontextprotocol/adcp-go/tmp"
    "github.com/adcontextprotocol/adcp-go/tmp/client"
    "github.com/prebid/prebid-server/modules"
)

type Module struct {
    client *client.Client
}

func New(cfg Config) *Module {
    return &Module{
        client: client.New(client.Config{
            Providers:      cfg.Providers,
            DefaultTimeout: time.Duration(cfg.TimeoutMs) * time.Millisecond,
        }),
    }
}

func (m *Module) HandleAuctionHook(ctx context.Context, payload modules.AuctionPayload) (modules.AuctionPayload, error) {
    // Build context match request from the Prebid auction payload
    for i, imp := range payload.BidRequest.Imp {
        tmpExt := extractTMPExt(imp)
        if tmpExt == nil {
            continue
        }

        req := tmp.NewContextMatchRequest(tmpExt.PropertyRID, tmpExt.PropertyType, tmpExt.PlacementID)
        req.Artifacts = tmpExt.Artifacts
        req.ContextSignals = tmpExt.ContextSignals
        req.Geo = tmpExt.Geo

        // Fan out to all context match providers
        res, err := m.client.FanOutContext(ctx, req)
        if err != nil {
            continue // graceful degradation — skip TMP for this imp
        }

        // Set targeting on the imp
        kvs := tmp.ToTargetingKVs(&tmp.JoinResult{
            Activated: toActivated(res.Offers),
            Signals:   res.Signals,
        })
        setImpTargeting(&payload.BidRequest.Imp[i], kvs)
    }

    return payload, nil
}
```

## Timeline

1. **SDK development** — Build `@adcp/client/tmp` and `adcp-go/tmp` against
   the TMP schemas shipping in AdCP 3.0.
2. **Reference adapters** — Working Prebid.js and Prebid Server adapters that
   the Prebid team can review and adapt.
3. **Prebid proposal submission** — Submit to Prebid.org with working code,
   performance benchmarks (payload size, latency), and Scope3 migration plan.
4. **Scope3 TMP endpoint** — Scope3 ships TMP-compatible endpoint.
5. **Publisher pilot** — One publisher runs TMP via Prebid alongside existing
   Scope3 RTD module, A/B comparison.
6. **Prebid core merge** — Prebid team adapts reference adapters to their
   codebase standards and merges.
