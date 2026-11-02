---
id: DR-0032
title: SDKs negotiate a release per counterpart and translate between the minors of a major; a mutation that would lose meaning is refused
class: normative
status: proposed
date: 2026-10-22
refs: ["#8373", "#8501", "#8433", "DR-0024", "DR-0034", "DR-0035", "DR-0036", "adcontextprotocol/adcp-client#3372", "adcontextprotocol/adcp-client#3376"]
dissent: none recorded
---

> **Revised 2026-11-02 against DR-0036.** First proposed on 2026-10-22 and parked at WG Session C pending #8501. #8501 settled on DR-0036: a minor adds only to open schemas. This revision narrows the record to what translation still has to do under that rule.

## Decision

**Application code speaks one release.** An AdCP SDK lets an application build requests and read responses in the newest release the SDK supports. The SDK picks the release to speak with each counterpart, per call: the highest release both sides support, from the counterpart's `supported_versions`. A prerelease matches only itself. A server serves a request that names only the major per DR-0034. The SDK converts between that release and the application's one consecutive minor at a time within the major (3.3 ↔ 3.2 ↔ 3.1, chained; likewise 4.1 ↔ 4.0).

**What translation covers.** Under DR-0036, a minor adds only to open schemas, so an older peer's validator accepts a newer field and then ignores it. The hazard is no longer a rejection but a silent ignore: a seller that ignores a cap or an exclusion spends differently from what was asked. Translation handles that hazard:

- **Newer fields go only to peers that negotiated the newer release.** A client removes them from a request before sending it to an older seller. A server removes them from a response served at an older release, as DR-0024 requires and DR-0036 states for the reopened proposal flow.
- **Moves.** Where a change's pathway statement (DR-0033) gives an exact equivalent in the older release, the SDK moves the value instead of removing it, in both directions.
- **Reads drop.** On a read, a removed field is reported and the call proceeds. The result may be broader than asked; the application sees why.
- **Mutations refuse.** On a mutating request, a field may be removed only if losing it leaves what the counterpart commits to unchanged: a label or a hint. If removing a field would change spend, targeting, caps, bidding, creative activation, measurement or account identity, the SDK refuses the call before sending, with a typed `UNSUPPORTED_FEATURE`-class error that names the field and the release that introduced it.
- **Every change is reported** where the application can see it, with the field's JSON path and the two releases.
- **Up-conversion never removes.** A client converting an older response up, and a server converting an older request up, apply moves only.
- **Tasks the negotiated release does not define** are refused before sending, unless the counterpart lists the tool.

**Closed and digest-bound objects are never reshaped.** A closed schema changes within a major only by a DR-0036 correction, which accepts what the spec text already required and so needs no translation. An object that a digest signs, such as `commercial-terms` under `terms_digest`, is never projected: if it cannot be represented in the served release, the resource is refused with `VERSION_UNSUPPORTED` rather than stripped.

**Account keys changed before DR-0036 reduce one-to-one.** 3.2 added `operator_unit`, `currency` and `timezone` to the account natural key, and `countries` to the brand inside it, on schemas 3.1 published closed. That change shipped and stays until 4.0 (DR-0036 records earlier cases instead of undoing them). For a peer on 3.1 or earlier, the SDK may send the older, reduced key only while the reduction is one-to-one:

- It records which reduced key each buyer key reached the seller with, and a key sent unreduced claims itself.
- It refuses, before sending, any second buyer key that would reach the same seller account, in either order, and checks every key in a request before recording any.
- After the seller upgrades, the reduced key stays in use until the buyer migrates the account. An `operator_unit`-only reduction is rekeyed in place with a `sync_accounts` settings update. A reduction by `currency`, `timezone` or `brand.countries` needs a new account under the full key, because those can't change on an existing account. `account_id` addressing is the recommended steady state for accounts opened across a version gap.

Reducing one-to-one is the default. An SDK may offer refusing instead. Future changes to account identity can't happen in a minor under DR-0036; they wait for a major.

**Shared conformance cases.** Each consecutive minor pair has cross-version cases in the compliance bundle (#8433), covering client and server in each direction, with an exact expected output, the reported changes, or the expected refusal. Every SDK runs them.

## Rationale

Without this, every buyer and seller rebuilds the same translation inconsistently: pinning outbound clients to old releases, reducing account keys by hand, and branching handlers on the served release. DR-0036 removes the worst failure, older validators rejecting newer payloads, but it turns the remaining one into a quieter one. An older peer now ignores what it doesn't know. On a read that is harmless and visible. On a mutation it means the seller commits to something other than what the buyer asked, so refusing is the only conversion that can't misspend.

A one-to-one reduction keeps account counts honest without merging two buyer accounts into one seller account or inventing brand identities, and it fails closed exactly where the older release can't tell keys apart.

## Implications

- **SDK consequences in `specs/version-negotiation.md` are updated** when this is ratified: auto-downshift is the default and is reported, not silent.
- **Reference implementation:** `@adcp/sdk` (adcontextprotocol/adcp-client#3372, #3376). The Python SDK shipped its translation in adcontextprotocol/adcp-client-python#1559. Go and Java track it in adcontextprotocol/adcp-go#588 and adcontextprotocol/adcp-sdk-java#47.
- **The conformance cases** in #8433 cover 3.2 ↔ 3.1 and the settled 3.3 ↔ 3.2 surfaces. 3.3 ↔ 3.2 is completed when 3.3 reaches GA and its closed-schema dispositions land.
- **Not settled here:** a wire signal telling the counterpart that a conversion withheld something. Reports on the converting side suffice for now.
