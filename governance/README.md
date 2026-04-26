# AgenticAdvertising.org governance documents

This directory mirrors the Foundation's governance documents into the AdCP repository so they are greppable and readable alongside the specification.

## Contents

| File | Authoritative URL | Version | Effective |
|---|---|---|---|
| [`bylaws.md`](./bylaws.md) | [`/api/agreement?type=bylaws`](https://agenticadvertising.org/api/agreement?type=bylaws) | 1.0 | 2025-12-10 |
| [`membership-agreement.md`](./membership-agreement.md) | [`/api/agreement?type=membership`](https://agenticadvertising.org/api/agreement?type=membership) | 1.1 | 2025-12-12 |

The [CHARTER.md](../CHARTER.md) at the repository root is a discoverability document that summarizes the Foundation's governance structure and links to each of these files and to the canonical URLs.

## Canonical-source rule

The Foundation website is authoritative. If this mirror and the website diverge — for any reason, including merge errors, stale exports, or admin updates not reflected here — **the website governs**. Each file in this directory carries a comment at the top naming its export date and referencing the canonical URL.

## Refreshing the mirror

When the Foundation updates a governance document, re-export with:

```bash
curl -sL 'https://agenticadvertising.org/api/agreement?type=bylaws&format=json' \
  | jq -r .text > /tmp/bylaws-body.md
# then re-prepend the canonical-source header and move into place
```

A future improvement (tracked as a nice-to-have) is a CI check that flags drift between the in-repo copy and the live endpoint.

## Antitrust policy

AAO does not publish a standalone antitrust policy document. Antitrust obligations are encoded in:

- [`bylaws.md`](./bylaws.md) — Article VII (and cross-references throughout)
- [`membership-agreement.md`](./membership-agreement.md) — §6.3 and §11 (compliance, meetings conduct)
- [`../CHARTER.md`](../CHARTER.md) §6 — summary with pointers

There is no `/api/agreement?type=antitrust_policy` endpoint; earlier versions of `CHARTER.md` referenced one, and those references have been corrected.

## Not mirrored here

| Document | Why |
|---|---|
| Terms of Service | Product-surface agreement (AAO website), not Foundation governance |
| Privacy Policy | Product-surface agreement, tracked in the AI disclosure and website footer |
| IP Policy | Already in-repo at [`../IPR_POLICY.md`](../IPR_POLICY.md) as the canonical source |
