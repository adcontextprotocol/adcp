# AgenticAdvertising.Org Charter

This charter is a discoverability document: it summarizes the Foundation's governance so readers who start at the repository can find the authoritative materials without first visiting the Foundation website. It does not create or modify governance. In any conflict between this document and the Bylaws, Membership Agreement, or IPR Policy, those documents control.

---

## 1. Foundation

**Legal entity:** AgenticAdvertising.Org (the "Foundation") is a pending 501(c)(6) nonprofit trade association incorporated in Delaware. Its purpose is to develop, maintain, and promote open, interoperable advertising standards — notably the Advertising Context Protocol (AdCP).

**Governing law:** Delaware, with exclusive jurisdiction in the Delaware courts.

**Public governance page:** [agenticadvertising.org/governance](https://agenticadvertising.org/governance)

---

## 2. Governing documents

The Foundation operates under a stack of public documents. Each is versioned and served from the Foundation website:

| Document | What it covers | Location |
|---|---|---|
| Bylaws | Board composition, elections, voting, officers, amendments | [`/api/agreement?type=bylaws`](https://agenticadvertising.org/api/agreement?type=bylaws) |
| Membership Agreement | Member obligations, category, fees, termination | [`/api/agreement?type=membership`](https://agenticadvertising.org/api/agreement?type=membership) |
| IPR Policy | Copyright, patent grants, trademark, contribution terms | [`IPR_POLICY.md`](./IPR_POLICY.md) |
| Antitrust Policy | Conduct rules for meetings and written exchanges | [`/api/agreement?type=antitrust_policy`](https://agenticadvertising.org/api/agreement?type=antitrust_policy) |
| Terms of Use | Website and service terms | [`/api/agreement?type=terms_of_service`](https://agenticadvertising.org/api/agreement?type=terms_of_service) |
| Privacy Policy | Data handling for Foundation services | [`/api/agreement?type=privacy_policy`](https://agenticadvertising.org/api/agreement?type=privacy_policy) |

---

## 3. Membership and voting classes

The Foundation has four voting member categories, reflecting the primary constituencies of the advertising ecosystem. Each category carries equal representation on the Board regardless of company size. Organizations eligible for more than one category choose a single category at join; category changes require Board approval and occur no more than once every 24 months.

| Class | Who it covers |
|---|---|
| **Brands (Advertisers)** | Companies advertising their own products and services, including direct-to-consumer brands, enterprise marketers, and retail media network operators acting as advertisers. |
| **Agencies** | Media agencies, creative agencies, and holding company units providing advertising services on behalf of advertisers. |
| **Publishers** | Content owners selling advertising inventory — digital publishers, broadcasters, out-of-home media owners, sales houses. |
| **Technology Providers** | Ad tech infrastructure — DSPs, SSPs, ad servers, measurement providers, data platforms. |

Non-voting **observer** participation is available through Working Groups and the public GitHub repository.

---

## 4. Board of directors

### 4.1 Interim board

The Foundation operates under an interim board appointed at incorporation. The interim board will be replaced by an elected board at the first Annual General Meeting (AGM), scheduled for **May 6, 2026**. All voting members in good standing as of the AGM record date are eligible to vote. Interim directors (as of 2026-04-18):

- Michael Blum — Scope3
- Brian O'Kelley — Scope3
- Pia Malovrh — Celtra
- Benjamin Masse — Triton Digital

The authoritative list, including current titles and any changes since this Charter was last updated, lives at [agenticadvertising.org/governance](https://agenticadvertising.org/governance).

### 4.2 Elected board

After the first AGM, the Board consists of elected directors plus the CEO, with **equal representation across voting classes** per the Bylaws. The current target (subject to the Bylaws) is ten seats per class:

| Class | Target seats |
|---|---|
| Brands | 10 |
| Agencies | 10 |
| Publishers | 10 |
| Technology Providers | 10 |

### 4.3 Executive Committee

The Board elects an Executive Committee for time-sensitive decisions: **three directors per voting class (12 total), plus the CEO**.

### 4.4 Terms and limits

- Director term: **3 years**
- Terms are **staggered**, with approximately one-third of the Board up for election each year
- Maximum **two consecutive terms**, followed by a one-year break before re-election

Officer roles (Chair, Vice-Chair, Treasurer, Secretary) and term details are defined in the Bylaws.

---

## 5. Specification lifecycle

AdCP progresses through two formal stages, defined in the [IPR Policy](./IPR_POLICY.md):

1. **Draft Specification** — a work-in-progress technical specification under Foundation review. Members must disclose Necessary Claims they have actual knowledge of during Draft development (see the IPR Policy Disclosure section).
2. **Final Specification** — a technical specification formally adopted by the Foundation for public use. Contributors grant the patent licenses in the IPR Policy under their Necessary Claims for compliant implementations.

Day-to-day technical work happens in **Working Groups**, which are the Foundation bodies responsible for developing, reviewing, and maintaining Draft and Final Specifications (defined in the [IPR Policy](./IPR_POLICY.md)). Each Working Group sets its own meeting cadence; see [`docs/community/working-group.mdx`](./docs/community/working-group.mdx) (also published at [docs.adcontextprotocol.org](https://docs.adcontextprotocol.org/docs/community/working-group)) for the current list and how to join.

**Change proposals** flow through the public [GitHub repository](https://github.com/adcontextprotocol/adcp) as issues and pull requests. Every merged change includes a changeset (see [CONTRIBUTING](https://github.com/adcontextprotocol/adcp/blob/main/CONTRIBUTING.md)); changes to the published protocol spec are versioned as patch / minor / major, and all other changes ship with an empty (non-versioning) changeset.

---

## 6. Conduct, recusal, and antitrust

- **Antitrust Policy** applies to all Foundation meetings, Working Group sessions, and written exchanges. Members acknowledge the Antitrust Policy at join. It is [linked above](#2-governing-documents).
- **Recusal** from votes and decisions is governed by the Bylaws. Working Group participants whose employer is a named party in a specific decision (e.g., a registry listing dispute involving their company) are expected to disclose and recuse where required.
- **Patent disclosure** obligations are in the [IPR Policy](./IPR_POLICY.md) (Disclosure section).
- **Appeals.** Disputes over Working Group decisions, registry listings, or certification outcomes are escalated under the process set out in the Bylaws. Open a GitHub issue or email [hello@agenticadvertising.org](mailto:hello@agenticadvertising.org) to initiate a review.

---

## 7. Transparency principles

- **Open meetings** — Board meetings publish agendas and minutes.
- **Public governing documents** — Bylaws, Membership Agreement, IPR Policy, and Antitrust Policy are publicly available.
- **Financial reporting** — Annual financial reports are shared with the membership.
- **Equal voice** — Each voting class has equal representation regardless of company size.
- **Public protocol development** — AdCP specification work happens in this repository; all changes are auditable in Git history.
- **Contributor credit** — Individuals and organizations who have shaped the protocol through issues, pull requests, and working-group participation are named in [CONTRIBUTORS.md](./CONTRIBUTORS.md).

---

## 8. Amendments

This Charter is a discoverability document and is updated when the underlying governance materials change. Material changes to the underlying governance (Bylaws, voting classes, Board composition) are made through the processes defined in the Bylaws and ratified by the membership.

---

## 9. Contact

- General: [hello@agenticadvertising.org](mailto:hello@agenticadvertising.org)
- Governance inquiries: via the [governance page](https://agenticadvertising.org/governance)
- Protocol questions: [GitHub Discussions](https://github.com/adcontextprotocol/adcp/discussions) or [Slack](https://join.slack.com/t/agenticads/shared_invite/zt-3h15gj6c0-FRTrD_y4HqmeXDKBl2TDEA)
