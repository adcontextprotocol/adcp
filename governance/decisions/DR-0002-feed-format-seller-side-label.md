---
id: DR-0002
title: feed_format is a seller-side parsing label, not an AdCP-owned mapping
class: normative
status: recorded
date: 2026-07-03
decided: ~2026-06
decided_by: maintainer practice
refs: ["#3456", "#5277"]
dissent: none
---

## Decision

`feed_format` in `brand.json` identifies how a seller parses a feed. AdCP does
not own or maintain a cross-platform feed-field mapping, and AdCP SDKs do not
parse feeds. Enum membership requires a platform-agnostic identifier (#3456's
criterion).

## Rationale

Owning a feed-format mapping would put the protocol in the business of tracking
every platform's ingestion quirks — an open corpus AdCP cannot authoritatively
maintain. The seller is the party that parses; the label is theirs.

## Implications

- Requests to add platform-specific enum values are evaluated against the
  platform-agnosticism criterion, not convenience.
- Field-level binding of feed columns to protocol fields is a separate layer
  (see #5277's catalog-driven render discussion) — not a `feed_format` concern.
