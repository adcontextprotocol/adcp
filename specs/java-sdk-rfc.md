# Java SDK RFC

**Status:** Draft for Builders Working Group
**Author:** Brian O'Kelley
**Created:** 2026-05-05
**Tracks parity with:** `@adcp/sdk` 6.x (TS, GA), `adcp` 4.x (Python, beta), `adcp-go` v1.x (dev)
**Layer model:** see [SDK stack reference](../docs/building/cross-cutting/sdk-stack.mdx)

## Why

Multiple AdCP adopters have requested a Java SDK. The JVM is the dominant
language at large publisher and ad-server platforms — GAM, FreeWheel, Magnite,
Index Exchange, PubMatic, Equativ, every broadcaster's middleware. Today those
teams either:

- Hand-roll L0–L3 from the published JSON schemas (~3–4 person-months per the
  SDK stack reference, with conformance debt every spec rev), or
- Stand up a Python sidecar in front of their JVM application — workable for a
  caller, painful for an agent that needs **shared transaction context with
  the existing decisioning engine** (the unique JVM win Python can't deliver).

Neither is a good answer for the SDK's largest unaddressed audience. This RFC
proposes a first-class Java SDK targeting full L0–L3 parity, on the same
release cadence as TS and Python.

**This RFC asks the Working Group to commit to Java as a fourth officially
supported language**, with the funding model and design-partner gating
described under [Decisions wanted](#decisions-wanted).

## Goals

1. **Conformance parity.** The Java SDK passes the same mock-mode storyboards
   that gate `@adcp/sdk` and `adcp`, **with storyboards in CI from v0.1, not
   v0.4**. Without that gate from day one, JVM teams won't trust the
   conformance claim.
2. **Both-sides coverage.** Caller, agent (server), signing, testing — same
   surface decomposition as TS.
3. **Idiomatic JVM.** Reads like a modern Java library, not a transliteration
   of the TS or Python API. Records, sealed types, `CompletableFuture` /
   virtual threads, JDK `HttpClient`, Jackson, SLF4J — defaults the JVM
   ecosystem already trusts.
4. **Framework-neutral core.** Core artifacts depend only on the JDK +
   Jackson + SLF4J. Spring Boot starter is the adoption surface for the
   majority of the audience; Quarkus / Micronaut / Servlet adapters live in
   optional artifacts.
5. **Maven Central from day one.** Group `org.adcontextprotocol`, signed
   artifacts, reproducible builds, JavaDoc + sources jars.

## Non-goals

- **Kotlin DSL as a separate v1.0+ release.** Kotlin co-releases with Java
  v1.0 — see [Kotlin positioning](#kotlin-positioning). Spring Boot 3.x is
  Kotlin-first in greenfield; "Java interop works" is technically true and
  culturally false at Kotlin shops.
- **Scala-native API.** Scala callers consume the Java surface.
- **Android.** The SDK targets server JVMs (publishers, agents,
  orchestrators).
- **Reinventing transport.** MCP and A2A bindings wrap upstream Java SDKs the
  same way TS wraps `@modelcontextprotocol/sdk` and `@a2a-js/sdk`.

## Reference: what the SDK has to ship

From [`docs/building/cross-cutting/sdk-stack.mdx`](../docs/building/cross-cutting/sdk-stack.mdx)
("What an SDK at each layer should provide"). Reproduced as a build target:

| Layer | Server side (agent) | Client side (caller) |
|---|---|---|
| L0 | Generated types from JSON schemas, schema validator, MCP+A2A transport adapters, schema-bundle accessor (build-time + runtime) | Same primitives, mirrored direction |
| L1 | RFC 9421 verification, replay-window enforcement, KMS-pluggable signing for outbound webhooks, verifier test harness | RFC 9421 outbound signing, webhook verification |
| L2 | Account-store abstraction, multi-tenant principal resolution, brand resolution, sandbox/live boundary | Agent-card publication, registry lookup, credential presentation |
| L3 | 7 lifecycle resources tracked + transition validators, idempotency cache (no-payload-echo on conflict, byte-identical replay within TTL), async-task store + dispatcher, webhook emitter, `comply_test_controller` surface, response envelope | State-machine *handlers*, idempotency-key generation, error-recovery classification, async-result polling, webhook receipt |
| L4 | Adopter | Adopter |

Surface parity target with `@adcp/sdk` 6.x (verified against
`adcontextprotocol/adcp-client` `package.json` exports) — collapsed to
**5 Maven artifacts at GA**, per JVM dependency-hygiene convention:

| `@adcp/sdk` exports covered | Java artifact | Contents |
|---|---|---|
| root, `/client`, `/types`, `/types/v2-5`, `/auth`, `/advanced`, `/schemas` (resources) | `org.adcontextprotocol:adcp` | Caller, generated types, version co-existence, schema bundle as resources |
| `/server`, `/server/legacy/v5`, `/signing`, `/signing/server`, `/signing/client`, `/express-mcp` (analogue) | `org.adcontextprotocol:adcp-server` | Agent-side primitives, RFC 9421, idempotency, async tasks, webhooks, `comply_test_controller` |
| `/testing`, `/testing/personas`, `/conformance`, `/compliance`, `/compliance-fixtures`, `/substitution`, `/signing/testing`, `/mock-server` | `org.adcontextprotocol:adcp-testing` | Storyboard runner, conformance harness, mock-server forwarding adapter, signing test fixtures |
| (TS framework integration is in-tree; JVM splits it) | `org.adcontextprotocol:adcp-spring-boot-starter` | Auto-configures handler, Jackson, signing, account store, Micrometer, Actuator |
| (TS CLI ships in `bin/adcp.js`) | `org.adcontextprotocol:adcp-cli` | Runnable jar; Homebrew tap as a Java-leads add |

Schemas ship as resources inside `adcp` (the JVM convention; not a separate
artifact). Quarkus / Micronaut / Servlet adapters land post-v1.0 on adopter
demand. Reactive bridges (`adcp-reactor`, `adcp-mutiny`) ship at GA — see
[Async model](#async-model).

CLI parity — `adcp <agent> [tool] [payload]`, `adcp storyboard run`,
`adcp grade` — ships as a runnable jar + Homebrew tap. **GraalVM
native-image is post-v1.0**, not a v1 commit; reflection config burden plus
moving API surface makes it premature.

## Architecture

### Java baseline

**Java 17 LTS as the compile + runtime baseline.** Java 17 gets us records,
sealed types, pattern matching, text blocks, `HttpClient`. On Java 21+, the
sync-shaped API scales via virtual threads automatically when the adopter
runs on a Loom-backed executor — no capability check, no multi-release JAR.
Document the ergonomics; let the runtime do the work.

### Type generation

**Build-time codegen from the published JSON Schemas, emitting Java records
for value/response types and builder records for request types.** Generator
invariant: `*Request` types always have builders; `*Response` types are
records and never do — this naming rule is what makes coding-agent assistance
(Claude / Copilot) work without hallucinating `.builder()` calls on
responses.

The TS SDK uses `json-schema-to-typescript` plus custom post-processors for
`x-adcp-*` annotations, polymorphic envelopes, and version pinning
(`scripts/generate-types.ts` in `adcontextprotocol/adcp-client`). An
off-the-shelf Java equivalent at that quality doesn't exist — `jsonschema2pojo`
predates records and handles AdCP polymorphism poorly. The Java SDK should
expect to ship a custom generator (probably built on Eclipse JDT or
JavaPoet), but the post-processor scope, not full codegen-from-zero.

### HTTP transport

**`java.net.http.HttpClient`** (JDK 11+) for HTTP/1.1 and HTTP/2. No
third-party HTTP client in the core artifact. Optional adapters for OkHttp
and Apache HttpClient 5 are post-v1.0 on demand (mostly to inherit
corporate proxy / mTLS configuration).

### JSON

**Jackson 2.x.** It's the de facto JVM JSON library and every Spring /
Quarkus / Micronaut adopter already ships it. Hard depend on
`jackson-databind` **>= 2.15** (the floor for full Java records support);
soft on `jackson-datatype-jsr310` for `Instant`. Document the floor
prominently — Spring Boot 2.7 shops on Jackson 2.13 will hit
`NoSuchMethodError` at runtime, the classic first-hour bounce.

### Schema validation

**`com.networknt:json-schema-validator`** — the actively maintained 2020-12
JSON Schema validator on the JVM. Lazy-load schemas from the bundled
resources jar; cache validators per schema URI. Same wiring shape as the TS
`SchemaValidator` and Python `adcp.validation`.

### MCP and A2A

- **MCP:** wrap the upstream MCP Java SDK. There are multiple in flight
  (Spring AI's, the official `io.modelcontextprotocol`); pick one before
  v0.1 ships, name it, don't drift between releases.
- **A2A:** the TS SDK wraps `@a2a-js/sdk ^0.3.4` — there's a stable JS
  upstream. Java A2A tooling is younger; if no maintained Java client
  exists at v0.1 cut, ship a minimal SSE consumer + JSON-RPC framer in
  `adcp-server` and migrate to an upstream wrapper when one stabilizes.

This matches how `@adcp/sdk` wraps both `@modelcontextprotocol/sdk` and
`@a2a-js/sdk`.

### Async model

The single biggest API-shape decision. Three options:

| Option | Pros | Cons |
|---|---|---|
| `CompletableFuture<T>` everywhere | JDK-native, no extra deps, integrates with every framework | Verbose chaining, awkward error handling, painful at L3 |
| Reactive in core (Reactor `Mono<T>` / RxJava `Single<T>`) | Powerful composition for WebFlux shops | Reactor is a fight in the dep graph for the median Spring MVC + servlet + blocking-JDBC adopter, who is *not* reactive |
| **Sync + virtual threads (Java 21 Loom)** | Reads like blocking code, scales like async on 21+, no API duplication, maps cleanly to TS `await` and Python `async def`, idiomatic for the median Spring shop | On 17–20 the sync methods block platform threads |

**Decision: sync-shaped public API everywhere.** The median Spring Boot
adopter is MVC + blocking JDBC, not WebFlux — sync is the *desired* idiom,
not a compromise. WebFlux and Quarkus shops get adapter artifacts:

- `org.adcontextprotocol:adcp-reactor` — wraps the sync surface in
  `Mono.fromCallable(...)` on a bounded elastic scheduler.
- `org.adcontextprotocol:adcp-mutiny` — the Quarkus equivalent.

**Both ship at GA, not fast-follow.** WebFlux shops left to wrap the sync
API themselves will own that complexity forever and we lose the canonical
surface.

`CompletableFuture<T>` mirror methods (`*Async`) ship only on the L0
transport entry points — the ~12 caller methods (`getProducts`,
`createMediaBuy`, `syncCreatives`, `listCreativeFormats`, etc.) where blocking
hurts most for callers stuck on Java 17–20. L2/L3 surfaces stay sync-only.
This bounds the API doubling.

### Signing (L1)

`adcp-server` includes signing primitives (no separate `adcp-signing`
artifact at v1 — collapses cleanly into server). Three providers:

1. **In-process keys** for development — Ed25519 / ECDSA via JCA. **No
   Bouncy Castle in the core artifact.** JDK 15+ has Ed25519 natively; the
   17 baseline makes BC unnecessary. Ship `adcp-signing-bouncycastle` as
   an optional FIPS-environment provider.
2. **AWS KMS** via `software.amazon.awssdk:kms`.
3. **GCP KMS** via `com.google.cloud:google-cloud-kms`.

`SigningProvider` is an SPI (`META-INF/services/`). KMS providers wire
**one cryptoKeyVersion per `adcp_use`** — the existing SDK lesson learned
the hard way: don't share keys across `request` / `webhook` / etc.
purposes; receivers enforce purpose at JWK `adcp_use`, not RFC 9421 tag.
Bake this into the API: `SigningProvider.forUse(AdcpUse.WEBHOOK)` returns
a different provider than `forUse(AdcpUse.REQUEST)`.

KMS init is **lazy**: gRPC retries forever on misconfig, and an eager init
at boot kills deploys silently. Pre-deploy probe is a separate command,
not part of the boot critical path.

RFC 9421 implementation: hand-roll the canonicalizer (it's small and
spec-tight). Don't depend on `org.tomitribe:http-signatures` — it's the
draft-Cavage spec, not RFC 9421, and quiet since 2022.

### Server framework integration (L2 + L3)

The server-side L3 surface is framework-neutral. Adapters glue it to a
hosting framework:

- `adcp-server` — core. Frameworks plug in via an `AdcpHttpHandler`
  interface (request → response).
- `adcp-spring-boot-starter` — **the adoption surface for ~70% of the
  audience.** Auto-configures handler, Jackson, signing provider, account
  store, **plus Micrometer `MeterRegistry` and Actuator
  `HealthIndicator` if those are on the classpath** (auto-published metric
  names like `adcp.tool.duration`, `adcp.signing.verify.failures`;
  `AdcpHealthIndicator` reports signing-key reachability and account-store
  reachability). Spring Security integration is documented as a recipe,
  not autoconfig — auth model is too opinionated to assume.

Quarkus / Micronaut / Servlet adapters land post-v1.0 on demand. The
shape model is the TS SDK's `createAdcpServerFromPlatform` /
`createAdcpServer`: `AdcpServer.builder().platform(myPlatform).build()`
with `platform` being the adopter's L4 implementation.

### Account store and multi-tenant (L2)

`AccountStore` interface. Reference impls:

- `InMemoryAccountStore` for tests.
- `JdbcAccountStore` against a Flyway/Liquibase-managed schema.
- Optional `JpaAccountStore` if Spring Data JPA shops want it.

Brand-resolution / agent-registry lookup goes through a separate
`RegistryClient` SPI so adopters can point at internal registries instead
of the public AAO registry.

### Idempotency cache (L3)

`IdempotencyStore` interface. Reference impls:

- `InMemoryIdempotencyStore` (tests, single-instance dev).
- `JdbcIdempotencyStore` (production default).
- `RedisIdempotencyStore` via Lettuce (high-throughput).

Two contracts the type system enforces:

1. **No-payload-echo on conflict.** `IdempotencyConflict` is a sealed type
   that structurally cannot carry a payload echo (read-oracle threat
   model — see
   [`L1/security.mdx#idempotency`](../docs/building/by-layer/L1/security.mdx)).
2. **Byte-identical replay within TTL.** Cached responses replay byte-for-byte;
   the store API takes / returns raw bytes alongside the typed response so
   replay can't accidentally re-serialize and drift.

### Lifecycle and transition validation (L3)

The TS SDK does **not** ship per-resource state machines today
(`adcp-client` `src/lib/server/decisioning/status-changes.ts` says: *"the
framework doesn't validate transitions in v6.0; the field is captured and
projected to the wire so downstream consumers can"*). The 7 resources
(`MediaBuy`, `Creative`, `Account`, `SISession`, `CatalogItem`, `Proposal`,
`Audience`) have spec-defined edges, but no shared YAML lifecycle source
exists yet across SDKs.

**The Java SDK has two paths:**

1. **Match TS today.** Capture transitions, project to wire, leave
   validation to the caller. Lower scope, lower confidence in
   cross-language conformance.
2. **Lead.** Author shared lifecycle YAMLs in the spec repo, wire all
   three SDKs (TS, Python, Java) to consume them. Higher scope, but it's
   the right shape regardless of who builds it first.

**Recommend path 2**, owned by the Java build but in coordination with
the TS / Python maintainers. The transition validator API takes
`(action, from, to)` — not `(from, to)` — because spec error-code
precedence depends on the attempted action: `NOT_CANCELLABLE` overrides
`INVALID_STATE` whenever the action is a cancel. A `(from, to)`-only API
loses that distinction.

`TransitionGuard` SPI lets adopters add preconditions (manual approval
gates, policy checks). Guards run *after* the spec edge check, so they
can never relax a spec edge. **Open risk:** a guard could silently
*narrow* an edge in a way that breaks conformance for buyers expecting
the edge to exist. Mitigation: guards declare which edges they touch;
conformance harness fails if a sandbox account's guards narrow any edge
the storyboards exercise.

### Async-task store and webhooks (L3)

`TaskStore` and `WebhookEmitter` SPIs. Same shape as `IdempotencyStore` —
in-memory + JDBC + Redis reference impls. Webhook delivery on a
configurable `ScheduledExecutorService` (virtual threads on 21+).

The async-task contract has a non-obvious requirement worth surfacing in
the API: **the task's terminal artifact must carry the original tool's
response shape**, not a generic task envelope (sdk-stack.mdx L111). The
`TaskStore.complete(taskId, artifact)` signature is generic in the
artifact type so the compiler enforces this per tool.

### `comply_test_controller` (L3)

`adcp-testing` artifact. The same controller surface that `@adcp/sdk`
ships under `/conformance` and `/compliance`, exposed through the same
`seed_*` / `force_*` / `simulate_*` tool names. Sandbox-only enforcement
is wired at the `AccountStore` boundary — production accounts get
`COMPLY_NOT_AVAILABLE` per spec.

**Mock-server forwarding contract.** Storyboards certify against the
shared reference mock-server, not against an in-process Java mock. The
storyboard runner forwards mock-mode traffic over HTTP to the
mock-server (same shape as TS `/mock-server`). Without this contract,
storyboards run against the SDK's own L4 stub instead of the
spec-compliance oracle, and certification fails.

### Schema-bundle consumption

Two paths, both required:

- **Build-time:** download the protocol tarball
  (`https://adcontextprotocol.org/protocol/{version}.tgz`), verify the
  Sigstore signature with `cosign verify-blob`, run codegen against the
  extracted schemas. Sigstore verification stays at build-time, not
  runtime.
- **Runtime:** schema-bundle accessor inside the published artifact for
  the validator and version pinning. `AdcpClient.builder().adcpVersion("3.1")`
  resolves against bundled resources at construction time.

### Testing utilities

`adcp-testing` artifact. JUnit 5 first-class.

- `AdcpAgentExtension` — JUnit 5 extension that boots an in-process
  agent (or wraps an adopter's agent) for storyboard runs.
- `StoryboardRunner` — Java port of the TS `runStoryboard`. Reads the
  same YAML storyboards from the protocol bundle, runs them against an
  agent under test, asserts wire conformance.
- `MockAgent` — for callers under test, the buyer-side mirror.
- `Personas` — port of `/testing/personas`.

This closes the storyboard-driven testing story for JVM adopters in the
language of the agent.

### Cross-cutting

- **Nullability annotations.** **JSpecify** on every public type. Affects
  Kotlin interop and IDE warnings on day one. No `Optional<T>` returns —
  Kotlin renders those as `Optional<T>!` and it's ugly; use
  `@Nullable T` instead.
- **Module system.** Classpath-only with `Automatic-Module-Name` set in
  every JAR's manifest. JPMS modules add friction; opt-in works for the
  WildFly / JBoss shops that need them.
- **Logging.** SLF4J facade. No `java.util.logging`, no
  `commons-logging` shim.
- **Generator invariant.** `*Request` always builds; `*Response` never
  does. Names enforce the invariant; coding-agent assistants stop
  hallucinating `.builder()` calls on response types.

## Spec gotchas a Java implementer should know

The TS and Python builds bled time on each of these. None are obvious from
the schemas.

1. **Idempotency cross-payload conflict semantics.** Same key + different
   payload → `IDEMPOTENCY_CONFLICT` with **no payload echo** (read-oracle
   threat model). Cached-response replay within TTL must be byte-identical.
   See [`L1/security.mdx#idempotency`](../docs/building/by-layer/L1/security.mdx).
2. **Async terminal-artifact shape.** A task's terminal artifact carries
   the *original tool's* response shape, not a generic task envelope.
3. **`VERSION_UNSUPPORTED` is `correctable` and must echo
   `supported_versions`.** Get either wrong and the caller can't recover.
   See [`version-adaptation.mdx`](../docs/building/cross-cutting/version-adaptation.mdx).
4. **Error recovery classification is wire-contract.**
   `transient` / `correctable` / `terminal` lives in the spec's
   `error-code.json` `enumMetadata` (PR #3738), not SDK-side metadata. The
   SDK consumes it, doesn't re-derive it.
5. **`NOT_CANCELLABLE` precedence over `INVALID_STATE`.** Whenever the
   attempted action is a cancel, the cancellation-specific code wins. The
   transition validator API needs the action, not just the edge.
6. **KMS keys distinct per `adcp_use`.** One key per signing purpose;
   receivers enforce purpose at JWK `adcp_use`. Don't share across
   request / webhook / etc.
7. **KMS lazy-init.** Eager init at boot can wedge deploys silently
   (gRPC retries forever on misconfig). Probe out-of-band.
8. **Storyboard hint fix-plan format.** Conformance failures emit
   structured `Diagnose / Locate / Fix / Verify` hints — surface them in
   adopter-facing test reports.

This is the Java SDK's "things we'd tell a new contributor" list, codified
upfront so it's not learned twice.

## Build, distribution, governance

- **Build system:** Gradle (better incremental, better multi-module, better
  match for codegen pipelines). Maven `pom.xml` published for consumers.
- **Repository:** new `adcontextprotocol/adcp-java` repo, same release
  cadence as the other SDKs.
- **Maven Central:** publish via Sonatype OSSRH, GPG-signed. Migrate to
  Sigstore for Maven Central once Sonatype's integration GAs.
- **Reproducible builds:** Gradle reproducible-jar + checked-in lockfiles.
- **CI:** GitHub Actions, matrixed across JDK 17 / 21, runs storyboard
  conformance against the reference mock-server **every PR from v0.1**.
  Same gate TS and Python use.

### Versioning

**SDK semver is independent of AdCP spec major.** `@adcp/sdk` is on 6.x
and `adcp` (Python) is on 4.x — both for AdCP 3.x. The TS coincidence of
"6.x for AdCP 3.x" is not a policy, just the artifact of `@adcp/sdk`'s
own pre-3.0 major history. Per
[`docs/reference/versioning`](../docs/reference/versioning.mdx) and the
cadence policy (PR #2359), each SDK major supports a defined window of
spec majors via co-existence imports.

The Java SDK starts at `1.0.0` for v1 GA. Co-existence imports (`adcp-v2-5`
namespace) cover supported spec-version windows.

## Kotlin positioning

Co-released with v1.0, not deferred. `adcp-kotlin` is a thin extension
artifact on top of the Java surface:

- Coroutine extensions (`suspend fun` wrappers) — small, generated.
- DSL builders for request types.
- Nullability already correct (JSpecify across the Java surface, see above).

Spring Boot 3.x is increasingly Kotlin-first. Defer this and Kotlin shops
hand-roll a wrapper; we lose the canonical surface, and the wrapper
diverges over time. Co-release is a few weeks on top of a clean Java
surface — not a parallel SDK.

## Migration path

Four audiences:

1. **Hand-rolled JVM agents** (a handful of publishers run these today).
   Same swap-one-layer-at-a-time path the
   [migrate-from-hand-rolled](../docs/building/by-layer/L4/migrate-from-hand-rolled.mdx)
   doc describes for TS, with JVM-specific entry points.
2. **Python sidecar shops.** Document the "delete the sidecar" path —
   typically multi-week, but the win (shared transaction context with
   the JVM data layer, no IPC) is large for high-volume agents.
3. **Kotlin/JVM agents on Spring Boot.** What works in v1.0 (Java interop
   via `adcp-kotlin`), what's coming (full DSL post-v1.0), pointer to
   the Kotlin extension artifact. Without this section Kotlin shops
   bounce on "no `suspend fun`" within an hour.
4. **New JVM agents.** Start at L4 against the full-stack SDK. Bulk of
   the audience.

## Open questions

1. **Async API shape on 17–20.** Sync-shaped + `*Async` mirror on the
   ~12 L0 caller methods — confirm the mirror surface size before
   v0.1 cut. Do we need `*Async` on `AdcpClient` builder methods too, or
   only on the tool-call methods?
2. **MCP Java SDK choice.** Spring AI's vs. official
   `io.modelcontextprotocol`. Decide by v0.1 cut; drifting between
   releases is worse than picking the less-mature one and migrating.
3. **A2A Java fallback shape.** Wrap upstream when stable, or ship
   minimal in-tree client now? Track upstream maturity at v0.1 cut.
4. **Shared lifecycle YAMLs.** Path 2 above (lead the cross-SDK
   lifecycle source) requires TS / Python maintainer buy-in. If they
   say no, fall back to path 1 and ship transition validators as a
   Java-internal shape.
5. **Spring Security integration depth.** Recipes-only vs. a separate
   `adcp-spring-boot-starter-security` artifact. Decide based on v0.3
   adopter feedback.
6. **Compatibility with Spring Boot 2.7.** End of OSS support is Nov
   2025; do we cover it for the long tail or set 3.x as the floor?
   Floor 3.x is cleaner; long tail at large enterprises is real.
7. **TransitionGuard narrowing protection.** Guards declaring the edges
   they touch — is that the right enforcement shape, or do we need a
   stronger contract?

## Proposed roadmap

A target shape, not a public commitment. **Realistic GA is M+12, not
M+9** — pre-committing M+9 and slipping is worse than committing M+12 and
beating it.

- **v0.1 (M+2):** L0 + storyboard CI gate. Generated types, schema
  validation, MCP transport, basic caller. Storyboards green against
  mock-server. Maven Central alpha.
- **v0.2 (M+4):** L1 — RFC 9421, KMS providers (lazy-init, per-`adcp_use`),
  webhook signing.
- **v0.3 (M+6):** Server-side L2 + partial L3 — account store,
  idempotency, async tasks. Spring Boot starter alpha.
- **v0.4 (M+9):** Full L3 — transition validators, webhook emission,
  `comply_test_controller`. A2A transport.
- **v1.0 (M+12):** GA. Full L0–L3 parity. `adcp-kotlin` co-released.
  Reactor and Mutiny adapters at GA, not later.

**Slippage risk concentrates on:** MCP Java SDK churn, RFC 9421
canonicalization edge cases (TS and Python both bled time here), shared
lifecycle YAML coordination, Spring Boot starter scope creep.

## Decisions wanted

In priority order:

1. **Funding / staffing.** The most important decision. Realistic shape:
   **a contributed engineer from a member org at 50%+ for ~12 months,
   plus a named WG maintainer with merge rights, plus 2 design partners
   committed to v0.1–v0.4.** Without all three, decline and revisit at
   the next major. Member-funded pooled is theoretically cleaner but
   slower to assemble; foundation grant unrealistic on this timeline.
2. **Design partners.** 2–3 JVM shops committing letters of intent to
   ship on the Java SDK in 2026. Without them this is build-it-and-they-
   will-come; with them it's de-risked. Candidates: a publisher running
   on Spring Boot, an SSP, a broadcaster middleware team.
3. **Yes/no on Java as a fourth officially supported language.** Commits
   the project to a fourth release per spec rev forever. Real ongoing
   cost worth a vote.
4. **Maintainer.** Named owner with merge rights post-GA. This RFC names
   no one.
5. **Scope cuts.** Anything in the roadmap above the WG thinks is out of
   v1: lifecycle YAML coordination, Reactor/Mutiny at GA, Kotlin
   co-release, Spring Boot starter Micrometer/Actuator integration.
6. **Cross-SDK lifecycle YAML.** Owners on TS and Python sides willing
   to consume a shared source. Affects path 1 vs. path 2 above.

## What kills adoption

Top three failure modes, codified so the build can hedge against them:

1. **Conformance gap with TS/Python.** If JVM storyboards lag by even
   one spec rev, JVM teams won't trust it. Storyboard CI from v0.1 — not
   v0.4 — is the structural protection.
2. **Spring Boot starter that's too thin or too opinionated.** Too thin
   and adopters write 200 lines of glue and ask why they need the SDK.
   Too opinionated and Spring Security / Actuator / Micrometer fights
   kill adoption. Wire observability, leave auth.
3. **Async API discord with the framework adopters are on.**
   Sync + virtual threads is correct for 21+. WebFlux shops without a
   Reactor adapter will wrap the sync API themselves and own that
   complexity forever. Reactor + Mutiny adapters at GA, not fast-follow.

## Appendix: example surface (illustrative)

Shape only — actual API determined by codegen + WG review.

### Caller

```java
import org.adcontextprotocol.adcp.AdcpClient;
import org.adcontextprotocol.adcp.AgentConfig;
import org.adcontextprotocol.adcp.Protocol;
import org.adcontextprotocol.adcp.task.GetProductsRequest;
import org.adcontextprotocol.adcp.task.GetProductsResponse;

var client = AdcpClient.builder()
    .agent(AgentConfig.builder()
        .id("sales")
        .agentUri("https://sales.example.com/mcp")
        .protocol(Protocol.MCP)
        .build())
    .build();

GetProductsResponse response = client.getProducts(
    GetProductsRequest.builder()
        .brief("Video campaign for pet owners")
        .build());
```

### Agent (Spring Boot)

```java
@Component
public class MyPlatform implements AdcpPlatform {
    @Override
    public GetProductsResponse getProducts(GetProductsRequest req, Principal p) {
        // L4 — adopter's inventory, pricing, decisioning
    }
    // ... other tools
}

// adcp-spring-boot-starter wires:
// - request handler, Jackson, signing provider, account store
// - Micrometer metrics if MeterRegistry present
// - Actuator AdcpHealthIndicator if Actuator present
// Spring Security integration is a documented recipe, not autoconfig.
```

### Storyboard test

```java
@AdcpStoryboardTest(agent = "my-agent")
class ConformanceTest {
    @Test
    void mediaBuyLifecycle() {
        StoryboardRunner.run("media-buy/lifecycle.yaml")
            .against(myAgent)
            .assertConformant();
    }
}
```

## References

- [SDK stack reference](../docs/building/cross-cutting/sdk-stack.mdx)
- [Choose your SDK](../docs/building/by-layer/L4/choose-your-sdk.mdx)
- [Schemas](../docs/building/by-layer/L0/schemas.mdx)
- [Security model](../docs/building/concepts/security-model.mdx)
- [Version adaptation](../docs/building/cross-cutting/version-adaptation.mdx)
- [Versioning](../docs/reference/versioning.mdx)
- [Conformance](../docs/building/verification/conformance.mdx)
- [`L1/security.mdx#idempotency`](../docs/building/by-layer/L1/security.mdx)
- `@adcp/sdk` source: github.com/adcontextprotocol/adcp-client
- `adcp` (Python) source: github.com/adcontextprotocol/adcp-client-python
- `adcp-go` source: github.com/adcontextprotocol/adcp-go
