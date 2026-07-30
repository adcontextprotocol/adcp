---
id: DR-0007
title: 12-month support window; majors every 1–2 years; 4.0 targeted early 2027
class: normative
status: recorded
date: 2026-07-03
decided: ~2026-04
decided_by: maintainer practice
refs: ["#2312", "PR #2359"]
dissent: none
---

## Decision

AdCP minor lines carry a 12-month support window. Major releases ship every
1–2 years; 4.0 is targeted for early 2027.

## Rationale

A deliberately short window for a young spec in a fast-moving AI domain: the
protocol needs the freedom to correct course while the adopter base is small
and integration surfaces are still forming.

## Implications

- The window is expected to lengthen toward enterprise norms (18–24 months) at
  future majors as the adopter base matures — revisit at each major, don't
  assume 12 months is permanent policy.
- Maintenance-line mechanics (cherry-pick flow, forward-merge, patch
  eligibility) are specified in `.agents/playbook.md` §Release lines.
