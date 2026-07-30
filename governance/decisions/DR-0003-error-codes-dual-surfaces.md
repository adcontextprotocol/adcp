---
id: DR-0003
title: New error codes ship on both enumDescriptions and enumMetadata
class: normative
status: recorded
date: 2026-07-03
decided: ~2026-05
decided_by: maintainer practice
refs: ["PR #3738", "#3725"]
dissent: none
---

## Decision

`enums/error-code.json` carries two parallel surfaces: `enumDescriptions`
(human-readable) and `enumMetadata` (structured, machine-readable). Every new
error code must add entries to **both**. SDKs read `enumMetadata` for recovery
classification.

## Rationale

PR #3738 introduced `enumMetadata` alongside the existing descriptions so SDKs
can classify errors (retryable, terminal, needs-human) without parsing prose. A
code present in one surface but not the other silently degrades SDK error
handling.

## Implications

- PR review of any `error-code.json` change checks both surfaces for parity
  (the Argus prompt's error-code trigger delegates this to
  `ad-tech-protocol-expert`).
- Description prose and metadata classification must agree; divergence is spec
  drift.
