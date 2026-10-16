---
id: DR-0024
title: A response conforms to the release it serves, with no exception for capabilities
class: normative
status: ratified
date: 2026-10-12
decided: 2026-10-12
decided_by: WG working session 2026-10-12
refs: ["#7718", "PR #8117"]
dissent: none recorded
---

## Decision

**The served release is binding.** A response to a request negotiated at release R, the release the response echoes in `adcp_version`, MUST validate against R's published schema.

**Newer shapes are projected or omitted.** Shapes introduced after R (new `oneOf`/`anyOf` arms, widened types, alternative required fields) MUST be projected to R's shape or omitted. New enum values stay under the unknown-value tolerance rule.

**A seller that cannot project for a release MUST NOT list it in `supported_versions`.**

**No exception for discovery.** The rule covers `get_adcp_capabilities`. A pinned capabilities request resolves to a served release or to `VERSION_UNSUPPORTED`, so the seller always has a release to project to.

**Negotiation fields are stable within a major.** `adcp.supported_versions`, `adcp.major_versions`, and the `adcp_version` echo MUST keep the same shape across every release of a major.

**Unpinned requests.** A request with no `adcp_version`, or with only `adcp_major_version`, is served at the default or highest release as the negotiation steps say, and the client parses tolerantly.

## Rationale

Version negotiation told the buyer which release was served but did not require the response to match it. 3.2 sellers serving a `"3.1"` pin could emit six shapes a strict 3.1 validator rejects, including a required-field flip in `sync_accounts`.

A SHOULD for the discovery call would have weakened compatibility on the call most likely to break an older typed client. The seller always knows the pin; the case with no release to project to is the unpinned request, which stable negotiation fields and tolerant parsing cover.

The escape valve makes the MUST enforceable: a seller is honest about the releases it can serve.

## Implications

The rule applies from 3.3, so no released seller becomes retroactively non-conformant.

**Conformance:** the `version_negotiation` storyboard grades it once the runner validates against a per-release schema bundle.

**SDKs:** server frameworks are expected to prune undefined properties against R's schema, apply projection transforms for the non-additive changes, and derive `supported_versions` from the releases they can project to.

**Not settled here:** signing-profile selection by negotiated version, which is tracked separately.
