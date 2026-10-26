---
id: DR-0032
title: SDKs translate between minor releases of a major; mutations refuse lossy conversion; reduced account keys stay one-to-one
class: normative
status: proposed
date: 2026-10-22
refs: ["#8373", "#8501", "#8502", "adcontextprotocol/adcp-client#3370", "adcontextprotocol/adcp-client#3372", "DR-0024"]
dissent: none recorded
---

> **Parked (WG Session C, 2026-10-26).** Not ratified. This waits on #8501 (closed schemas gaining fields in minor releases), following an objection from @KonstantinMirin. The WG has since adopted the rule that a minor release never adds or removes a property on a closed schema, and #8502 enforces it in CI. That narrows how much translation SDKs need, so this record will be revised against the outcome of #8501 before it is put up for ratification again.

## Decision

**Application code speaks one release.** An AdCP SDK lets an application build requests and read responses in the newest release the SDK supports. The SDK negotiates the highest release both sides support, per counterpart and per call, and converts between that release and the application's, one consecutive minor at a time within the major (3.2 ↔ 3.1 ↔ 3.0, chained; likewise 4.1 ↔ 4.0). This holds for client SDKs (convert requests down, responses up) and server frameworks (convert requests up, responses down, as [DR-0024] requires of responses).

**Every loss is reported.** A conversion that removes or rewrites a field reports it where the application can see it, with the field's JSON path and the two releases.

**Reads drop; mutations refuse.**
- On a read, a field the older release cannot express is removed and reported.
- On a mutation, the SDK removes only fields that do not change what the counterpart commits to: labels and hints (a buy's `name`, `pacing`, creative rotation hints). If any other field would be lost (a cap, a targeting exclusion, a bidding mode, any field of an update), the SDK refuses the call before sending, with a typed `UNSUPPORTED_FEATURE`-class error.
- A field with an exact older equivalent is moved, not dropped. Moves are defined by the shared conformance cases (see below), never by one SDK.

**A task the older release does not define** is refused before sending with a typed error, unless the counterpart lists the tool.

**Account keys.** When the older release's account natural key cannot express fields of the buyer's key (3.2's `operator_unit`, `currency`, `timezone` and `brand.countries`), the SDK may send the older, reduced key only when the reduction is one-to-one:
- It records which reduced key each buyer key reached the seller with.
- It refuses a second buyer key that would reach the same seller account, and refuses a request that sends that reduced key unchanged on behalf of another buyer key.
- It never merges two buyer accounts into one seller account.

**When the seller upgrades**, a reduced account keeps being addressed by its reduced key (or by `account_id`) until the buyer migrates it explicitly:
- An `operator_unit`-only reduction is rekeyed in place with a `sync_accounts` settings update (`account`, `operator_identity`, `revision`).
- An account reduced by `currency`, `timezone` or `brand.countries` cannot change those on an existing account, so the buyer opens a new account under the full key and decides which key keeps the history.
- `account_id` addressing is the recommended steady state for accounts first opened across a version gap.

**Shared conformance cases.** Every consecutive minor pair has cross-version cases in the compliance bundle. They cover each direction for both client and server: input, expected output, expected drops, or expected refusal. Every SDK runs them.

## Rationale

Without this, each buyer and seller rebuilds the same translation, inconsistently: pinning outbound clients to old releases, reducing account keys by hand, and branching handlers on the served release. Dropping fields from a mutation is the dangerous case. A buy sent without its budget cap or exclusion still succeeds, and spends differently from what was asked. Refusing is the only conversion that cannot misspend.

Sharing a reduced account key looks harmless but merges billing terms, spend, reporting and read access across buyer accounts, for example two buying desks. Encoding the dropped fields into `brand_id` invents brand identities the house never published. A one-to-one reduction keeps account counts honest without either cost, and fails closed exactly where the older release cannot tell keys apart.

## Implications

- Updates the "SDK consequences" section of `specs/version-negotiation.md`: auto-downshift is the default, and it is reported rather than silent.
- Supersedes nothing. [DR-0024]'s rule that responses conform to the served release is how the server side of this decision is graded. Its unpinned-request clause is addressed separately in DR-0034.
- The conformance cases are a follow-up deliverable. Until they exist, SDKs document their moves and refusals.
- Not settled here: a wire signal telling the counterpart that a conversion withheld something. Logs and callbacks on the converting side suffice for now.

[DR-0024]: ./DR-0024-responses-conform-to-served-release.md
