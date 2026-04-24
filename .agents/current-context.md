# Current Context

Snapshot of what's active in the AdCP ecosystem. Refreshed weekly by the
context-refresh routine. Human edits welcome between refreshes.

Last refresh: 2026-04-24

## In flight — spec

- **AdCP 3.0 GA** — shipped. SDKs pinned to 3.0.0
  ([adcp-go#74](https://github.com/adcontextprotocol/adcp-go/pull/74),
  [adcp-client-python#255](https://github.com/adcontextprotocol/adcp-client-python/pull/255)).
  Docs snapshot open in [PR #2897](https://github.com/adcontextprotocol/adcp/pull/2897).
  Status: **shipped**.
- **v2 sunset** — [#2220](https://github.com/adcontextprotocol/adcp/issues/2220).
  Security-only until 2026-08-01. Status: **active**.
- **Release model post-3.0** — cadence
  [#2312](https://github.com/adcontextprotocol/adcp/issues/2312) /
  [PR #2359](https://github.com/adcontextprotocol/adcp/pull/2359); branch model
  RFC [#2421](https://github.com/adcontextprotocol/adcp/issues/2421);
  tag-at-merge to prevent drift [#2366](https://github.com/adcontextprotocol/adcp/issues/2366).
  Status: **active**.
- **Schema URL discipline** — docs pinned to `/schemas/v3/`, Addie driven from
  live registry ([PR #2959](https://github.com/adcontextprotocol/adcp/pull/2959)).
  Status: **shipped**.
- **3.1 scoping** — GDPR Art. 22 [#2394](https://github.com/adcontextprotocol/adcp/issues/2394),
  FX [#2393](https://github.com/adcontextprotocol/adcp/issues/2393), cross-agent
  trust [#2392](https://github.com/adcontextprotocol/adcp/issues/2392), billing
  reconciliation [#2391](https://github.com/adcontextprotocol/adcp/issues/2391),
  buyer/orchestrator storyboards [#2424](https://github.com/adcontextprotocol/adcp/issues/2424),
  consent-scope [#2540](https://github.com/adcontextprotocol/adcp/issues/2540),
  re-add preview specialisms [#2511](https://github.com/adcontextprotocol/adcp/issues/2511),
  policy_id attribution [#2303](https://github.com/adcontextprotocol/adcp/issues/2303).
  Status: **active**.
- **4.0 scoping** — seller-attested `report_usage`
  [#2479](https://github.com/adcontextprotocol/adcp/issues/2479). Status: **active**.
- **RFC: Dependency Impact & Health Notifications** — epic
  [#2853](https://github.com/adcontextprotocol/adcp/issues/2853); children
  add `at_risk`/`impacts[]` [#2855](https://github.com/adcontextprotocol/adcp/issues/2855),
  impact notification_type [#2856](https://github.com/adcontextprotocol/adcp/issues/2856),
  storyboards + coherence assertion
  [#2857](https://github.com/adcontextprotocol/adcp/issues/2857)–[#2860](https://github.com/adcontextprotocol/adcp/issues/2860).
  Status: **active**.
- **RFC: Request signing (RFC 9421)** — mandatory on mutating calls
  [#2307](https://github.com/adcontextprotocol/adcp/issues/2307),
  A2A relay model [#2324](https://github.com/adcontextprotocol/adcp/issues/2324),
  revocation heartbeat [#2325](https://github.com/adcontextprotocol/adcp/issues/2325).
  Status: **active**.
- **AI Provenance Extensions** —
  [#2854](https://github.com/adcontextprotocol/adcp/issues/2854). Status: **active**.

## In flight — protocol extensions

- **TMP (adcp-go 1.0)** — released ([PR adcp-go#29](https://github.com/adcontextprotocol/adcp-go/pull/29)).
  Recent merges: RFC 9421 signing ([#58](https://github.com/adcontextprotocol/adcp-go/pull/58)),
  webhook signing ([#64](https://github.com/adcontextprotocol/adcp-go/pull/64)),
  3.0 capability types ([#61](https://github.com/adcontextprotocol/adcp-go/pull/61),
  [#71](https://github.com/adcontextprotocol/adcp-go/pull/71)),
  pricing variants ([#65](https://github.com/adcontextprotocol/adcp-go/pull/65)),
  schema drift linter ([#76](https://github.com/adcontextprotocol/adcp-go/pull/76)).
  Status: **active**.
- **A2A 1.0 migration** — adcp-client-python on a2a-sdk 1.0 with 0.3 wire-compat
  shim ([#261](https://github.com/adcontextprotocol/adcp-client-python/pull/261),
  breaking checkpoint API [#258](https://github.com/adcontextprotocol/adcp-client-python/pull/258));
  4.1.0 release PR [#257](https://github.com/adcontextprotocol/adcp-client-python/pull/257).
  Docs migrated ([PR #2968](https://github.com/adcontextprotocol/adcp/pull/2968));
  hardening + test-vectors follow-up
  [#2966](https://github.com/adcontextprotocol/adcp/issues/2966). Status: **review**.
- **TMP docs & training** — epic
  [#1935](https://github.com/adcontextprotocol/adcp/issues/1935), S6 specialist
  [#1745](https://github.com/adcontextprotocol/adcp/issues/1745),
  provider guide [#1733](https://github.com/adcontextprotocol/adcp/issues/1733).
  Status: **active**.

## In flight — testing / compliance

- **Test kit maturation (adcp-client)** — fixture-authoritative runner
  ([#816](https://github.com/adcontextprotocol/adcp-client/pull/816)),
  shape-drift hints for list + sync_creatives/preview_creative
  ([#851](https://github.com/adcontextprotocol/adcp-client/pull/851),
  [#853](https://github.com/adcontextprotocol/adcp-client/pull/853)),
  strict/lenient response-schema reporting ([#831](https://github.com/adcontextprotocol/adcp-client/pull/831)),
  creative-agent ergonomics ([#848](https://github.com/adcontextprotocol/adcp-client/pull/848)).
  Status: **active**.
- **Compliance storyboard gaps** — `governance_aware_seller` phase loss
  ([#2972](https://github.com/adcontextprotocol/adcp/issues/2972),
  [#2923](https://github.com/adcontextprotocol/adcp/issues/2923); fix
  [PR #2973](https://github.com/adcontextprotocol/adcp/pull/2973)); filter-behaviour
  gap [#2902](https://github.com/adcontextprotocol/adcp/issues/2902); SKILL.md
  post-compliance checkpoint [#2903](https://github.com/adcontextprotocol/adcp/issues/2903);
  substitution-safety template ([#2651](https://github.com/adcontextprotocol/adcp/issues/2651),
  [#2654](https://github.com/adcontextprotocol/adcp/issues/2654),
  [PR #2730](https://github.com/adcontextprotocol/adcp/pull/2730)). Status: **active**.
- **Tier-2 Production Verified via CD observability** —
  [#2965](https://github.com/adcontextprotocol/adcp/issues/2965).
  Status: **active**.
- **Capability introspection + RBAC error codes** —
  [#2964](https://github.com/adcontextprotocol/adcp/issues/2964),
  `bills_through_adcp` [#2881](https://github.com/adcontextprotocol/adcp/issues/2881),
  "no usage records" error [#2882](https://github.com/adcontextprotocol/adcp/issues/2882).
  Status: **active**.

## In flight — ecosystem

- **Addie cost-cap observability** — per-user Anthropic cap + dashboard +
  fail-closed default shipped ([PRs #2946](https://github.com/adcontextprotocol/adcp/pull/2946),
  [#2954](https://github.com/adcontextprotocol/adcp/pull/2954),
  [#2961](https://github.com/adcontextprotocol/adcp/pull/2961),
  [#2969](https://github.com/adcontextprotocol/adcp/pull/2969)); Slack scope +
  tier cache open ([#2976](https://github.com/adcontextprotocol/adcp/pull/2976)).
  Status: **shipped** (core).
- **Dashboard 429 UX** — concurrency cap, countdown, a11y shipped
  ([PR #2933](https://github.com/adcontextprotocol/adcp/pull/2933),
  [#2941](https://github.com/adcontextprotocol/adcp/pull/2941));
  clear-state fix open ([PR #2940](https://github.com/adcontextprotocol/adcp/pull/2940)).
  Status: **review**.
- **WorkOS OAuth across surfaces** — user JWTs on `/api/*`
  ([PR #2962](https://github.com/adcontextprotocol/adcp/pull/2962)),
  operator/agents ([#2956](https://github.com/adcontextprotocol/adcp/pull/2956)),
  per-token JWKS ([#2960](https://github.com/adcontextprotocol/adcp/pull/2960)),
  CLI/Addie ([#2677](https://github.com/adcontextprotocol/adcp/issues/2677)),
  multi-resource indicator ([#2805](https://github.com/adcontextprotocol/adcp/issues/2805)),
  DCR probe misreport ([#2955](https://github.com/adcontextprotocol/adcp/issues/2955)).
  Status: **active**.
- **A2UI / brand.json theming** — palette at session init
  ([#2918](https://github.com/adcontextprotocol/adcp/issues/2918)),
  disclosure/chrome ([#2919](https://github.com/adcontextprotocol/adcp/issues/2919)),
  user-action → SI event mapping ([#2920](https://github.com/adcontextprotocol/adcp/issues/2920)).
  Status: **active**.
- **Member editorial epic** —
  [#2693](https://github.com/adcontextprotocol/adcp/issues/2693). Announcement
  drafter + editorial review shipped
  ([PR #2926](https://github.com/adcontextprotocol/adcp/pull/2926),
  [#2975](https://github.com/adcontextprotocol/adcp/pull/2975)); editor polish
  open ([PR #2766](https://github.com/adcontextprotocol/adcp/pull/2766));
  Addie hallucinations [#2697](https://github.com/adcontextprotocol/adcp/issues/2697),
  [#2698](https://github.com/adcontextprotocol/adcp/issues/2698).
  Status: **active**.
- **Addie files issues via WorkOS Pipes** —
  [PR #2967](https://github.com/adcontextprotocol/adcp/pull/2967). Status: **shipped**.
- **Governance WG publishing** — RFC process
  [#2437](https://github.com/adcontextprotocol/adcp/issues/2437), WG charter
  [#2438](https://github.com/adcontextprotocol/adcp/issues/2438), spec lifecycle
  [#2441](https://github.com/adcontextprotocol/adcp/issues/2441), minutes archive
  [#2442](https://github.com/adcontextprotocol/adcp/issues/2442). Status: **active**.

## In flight — agent infra

- **Triage routine v2** — expert consultation, silent-triage, execute-when-clear
  shipped ([PRs #2936](https://github.com/adcontextprotocol/adcp/pull/2936),
  [#2944](https://github.com/adcontextprotocol/adcp/pull/2944),
  [#2949](https://github.com/adcontextprotocol/adcp/pull/2949),
  [#2957](https://github.com/adcontextprotocol/adcp/pull/2957),
  [#2958](https://github.com/adcontextprotocol/adcp/pull/2958)). Status: **shipped**.
- **Claude Code routines across repos** — scaffolding in all four repos
  (adcp#2925, adcp-client#834, adcp-client-python#259, adcp-go#80);
  `/claude-triage` nudge [PR #2970](https://github.com/adcontextprotocol/adcp/pull/2970);
  expert/context split review ([#2977](https://github.com/adcontextprotocol/adcp/pull/2977),
  [#2974](https://github.com/adcontextprotocol/adcp/pull/2974)). Status: **active**.

## Clients and implementations

- **adcp-client** (TypeScript) — regular releases
  ([#828](https://github.com/adcontextprotocol/adcp-client/pull/828),
  [#809](https://github.com/adcontextprotocol/adcp-client/pull/809)); 0 open PRs.
- **adcp-client-python** — v4.0.0 shipped
  ([#177](https://github.com/adcontextprotocol/adcp-client-python/pull/177));
  v4.1.0 release queued ([#257](https://github.com/adcontextprotocol/adcp-client-python/pull/257)).
  Schema-driven validation + middleware, AccountAwareToolContext, v3→v4 codemod.
- **adcp-go** — 1.0 released. Open: privacy-scoped audience keys
  ([#81](https://github.com/adcontextprotocol/adcp-go/pull/81)),
  DeleteUserProfile ([#79](https://github.com/adcontextprotocol/adcp-go/pull/79)),
  Store abstraction long-open ([#11](https://github.com/adcontextprotocol/adcp-go/pull/11)).

## Narratives and gaps

- **Seller-side quickstart** — mirror buyer quickstart
  ([#2827](https://github.com/adcontextprotocol/adcp/issues/2827)). Status: **active**.
- **Trust landing for CISOs** —
  [#2817](https://github.com/adcontextprotocol/adcp/issues/2817);
  SECURITY.md 404 [#2812](https://github.com/adcontextprotocol/adcp/issues/2812).
  Status: **active**.
- **Certification S6 (security)** —
  [#2369](https://github.com/adcontextprotocol/adcp/issues/2369),
  [#2386](https://github.com/adcontextprotocol/adcp/issues/2386),
  [#1745](https://github.com/adcontextprotocol/adcp/issues/1745). Status: **active**.
- **Academy / broadcast** — B0 SSP on-ramp
  [#2572](https://github.com/adcontextprotocol/adcp/issues/2572),
  A2.5 testing lab [#2571](https://github.com/adcontextprotocol/adcp/issues/2571),
  broadcast TV training [#2047](https://github.com/adcontextprotocol/adcp/issues/2047),
  radio/audio formats [#2072](https://github.com/adcontextprotocol/adcp/issues/2072).
  Status: **active**.
