---
id: DR-0006
title: v2 is unsupported as of 3.0 GA; security-only until 2026-08-01, then deprecated
class: normative
status: recorded
date: 2026-07-03
decided: ~2026-04
decided_by: maintainer practice
refs: ["#2220"]
dissent: none
---

## Decision

AdCP v2 is unsupported as of 3.0 GA (April 2026). The 2.x line receives
security-only fixes until **2026-08-01**, after which it is fully deprecated.
v2 is not safe for production use — it predates accounts and governance.

## Rationale

Carrying a pre-governance protocol line indefinitely splits implementer
attention and implies a safety level v2 does not have. A dated, published
sunset gives adopters a concrete migration deadline.

## Implications

- New features never land on 2.x. Security fixes stop 2026-08-01.
- Docs, Addie, and certification content describe v2 in migration terms only.
