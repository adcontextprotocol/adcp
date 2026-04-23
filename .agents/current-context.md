# Current Context

Snapshot of what's active in the AdCP ecosystem. Refreshed weekly by the
context-refresh routine. Human edits welcome between refreshes.

Last refresh: 2026-04-23 (initial seed)

## In flight — spec

- **AdCP 3.0 GA** — shipped. See PR [#2907](https://github.com/adcontextprotocol/adcp/pull/2907)
  (SDK compatibility matrix). Status: **shipped**.
- **v2 sunset policy** — issue [#2220](https://github.com/adcontextprotocol/adcp/issues/2220).
  v2 unsupported as of 3.0 GA; security-only until 2026-08-01; fully
  deprecated after. Not safe for production (no accounts/governance).
  Status: **active**.
- **Release cadence policy** — PR [#2359](https://github.com/adcontextprotocol/adcp/pull/2359),
  issue [#2312](https://github.com/adcontextprotocol/adcp/issues/2312).
  12-month support window, early-2027 4.0. Tighten to enterprise windows
  (18-24mo) at future majors. Status: **active**.
- **Upstream spec issues filed** — [#2335](https://github.com/adcontextprotocol/adcp/issues/2335)
  (stale digest, merged via #2337, tarball repub pending);
  [#2341](https://github.com/adcontextprotocol/adcp/issues/2341)
  (sf-binary base64 ambiguity);
  [#2343](https://github.com/adcontextprotocol/adcp/issues/2343)
  (URL canonicalization vectors). Status: **active**.
- **Lifecycle formalization** — issues
  [#1612](https://github.com/adcontextprotocol/adcp/issues/1612)–[#1616](https://github.com/adcontextprotocol/adcp/issues/1616).
  State machines across creative, accounts, SI sessions, catalogs.
  Follows media-buy lifecycle PR #1611. Status: **active**.

## In flight — protocol extensions

- **TMP implementation** — Go SDK, reference agents, perf benchmarks
  (OpenRTB vs TMP JSON vs Cap'n Proto), Addie live demo. Building in
  subdirectories first. Status: **active**.
- **DBCFM integration** — German DBCFM standard mapping to AdCP.
  David Porzelt gap analysis. Related PRs:
  [#1594](https://github.com/adcontextprotocol/adcp/pull/1594)
  (price_breakdown),
  [#1605](https://github.com/adcontextprotocol/adcp/pull/1605)
  (business entities),
  [#1664](https://github.com/adcontextprotocol/adcp/pull/1664)
  (proposal lifecycle). Status: **active**.
- **Buy terms negotiation** — PR [#1962](https://github.com/adcontextprotocol/adcp/pull/1962).
  Performance standards, measurement terms, cancellation, makegoods.
  adcp-client#423 depends on this. Status: **review**.
- **Event lifecycle** — PR [#2019](https://github.com/adcontextprotocol/adcp/pull/2019)
  is the foundation. Post-sync follow-ups, newsletter pickup, Slack
  nudges, member dashboard. Status: **active**.

## In flight — ecosystem

- **Property catalog** — fact graph for property universe. Scope3 seeds
  with existing alias/ad-infra knowledge; switches to AAO as primary.
  Spec: `specs/property-registry-catalog.md`. Status: **active**.
- **Brand.json as agent registry** — brand.json is canonical source for
  public agent discovery; no independent AAO registry. brand.json =
  "what I own", adagents.json = "who can sell it". Status: **shipped**.
- **Brand properties → catalog pipeline** — brand.json properties feed
  property catalog via crawler. Status: **active**.
- **Agent visibility tiers** — three-tier (private/members-only/public)
  visibility for agents. Non-paying capped at members-only. Solves
  Scope3 discovery without forcing membership. Status: **active**.
- **TMP GDPR controller/processor** — router = processor, buyer needs
  DPA scrutiny, pricing is offline. Drove new data-protection-roles
  doc. Status: **shipped**.

## Clients

- **adcp-client** (TypeScript) — conformance runs via Addie's
  `test_adcp_agent` tool. PR #423 waits on buy-terms (spec #1962).
- **adcp-client-python** — published Python client. Both SDKs ship
  server primitives + testing utilities. Docs framing reads
  caller-first.

## Recent infra

- **TSConfig strict aligned** — PR [#2896](https://github.com/adcontextprotocol/adcp/pull/2896).
  Root was `strict:false`, `server/tsconfig.json` (CI) was
  `strict:true`. Aligned. Status: **shipped**.
- **Registry agents snapshot tables** — PR 86eba0cd2. Materialize
  agent health + capabilities in DB snapshot tables. Status: **shipped**.

## Narratives and gaps

- **Security narrative gap** — mechanics exist (security.mdx,
  idempotency, auth declarations) but no community-facing narrative or
  curriculum. Brian flagged as tier-1 gap 2026-04-19. Status: **active**.
- **SDK both-sides framing** — @adcp/client and adcp (Python) ship
  server primitives + testing utilities. Docs framing reads
  caller-first, hides this. Status: **active**.
