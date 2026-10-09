---
id: DR-0022
title: Unsigned MCP transport sessions carry no AdCP authority
class: normative
status: proposed
date: 2026-09-20
decided_by: pending WG ratification
refs: ["#7566"]
dissent: none reported; WG review pending
---

## Decision

For AdCP 3.2, `Mcp-Session-Id` remains outside the RFC 9421 covered-component
set. Verifiers do not attribute identity, authorization, account selection,
resource access, or task ownership to that header or other unsigned
session-continuity or routing metadata. Recognized per-request credential
channels such as `Authorization` remain authoritative. When request signing
applies, its covered components and digest-bound body also participate in the
decision; public and bootstrap operations retain their documented policy.

Stateful MCP implementations may retain transport continuity and task-waiting
state in a session. Session-local caches are consulted only after authentication
and are additionally keyed by authenticated principal and account. Rebinding a
valid request to another session cannot change the principal, authorization
decision, resource namespace, returned cached data, or ownership decision.

## Rationale

The v1 request-signing profile fixes the covered-component set and forbids
uncoordinated additions. Adding `mcp-session-id` conditionally would require a
new profile tag and a coordinated wire transition. The existing AdCP model
already places continuity and authority in the signed request body and
per-request credentials, so making the transport session explicitly
non-authoritative closes the implementation hazard without changing the wire
profile or breaking stateless MCP transports.

## Implications

Implementations must not use an MCP session as an authenticator, tenant
selector, or task-ownership grant. Session-local transport state remains
allowed only when it cannot affect those decisions.

This record does not ratify itself. The implementation PR is the ratification
vehicle. A future profile may cover `mcp-session-id`, but that requires a new
request-signing profile version rather than mutation of v1.
