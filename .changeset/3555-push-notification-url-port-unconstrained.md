---
"adcontextprotocol": minor
---

`pushNotificationConfig.url` port semantics: declare unconstrained by default ([adcp#3555](https://github.com/adcontextprotocol/adcp/issues/3555)).

The 3.0 spec was silent on whether publishers may restrict destination ports on buyer-supplied webhook URLs, leaving SDK authors to choose between two bad defaults: lock to `{443, 8443}` (silently rejects buyers on Tomcat `:9443`, Spring Boot `:4443`, path-routed multi-tenant gateways) or accept any port (weakens defense-in-depth).

Resolution — the SSRF guard the protocol relies on is the **IP-range check + DNS-rebinding-resistant connect pin** already defined in `security.mdx#webhook-url-validation-ssrf`, not port filtering. Reserved-range checks cover the realistic threat (smuggling traffic to internal services on `10.0.0.0/8`, `127.0.0.0/8`, `169.254.169.254`); port filtering on top of a routable public IP is a marginal defense whose cost (rejecting conformant buyers) typically exceeds its benefit.

**Normative position** (now stated in `docs/building/by-layer/L1/security.mdx#destination-port-permissive-by-default`):

- Publishers SHOULD NOT enforce a destination-port allowlist on counterparty-supplied URLs by default. The URL contract is `format: "uri"` only; the protocol does not constrain ports.
- Operators who want a hardened destination-port allowlist as defense-in-depth (locked-down enterprise egress) opt in explicitly via SDK or deployment configuration, with `{443, 8443}` as a reasonable hardened-mode starting point.
- SDKs that ship a `DEFAULT_ALLOWED_PORTS` constant MUST default it to "no restriction" and surface `{443, 8443}` as an opt-in profile, never as a default.
- Sellers that activate hardened mode MUST document the allowed-port set in their operator-facing documentation.

Schema description in `push-notification-config.json` updated to point at the security-doc section; normative SHOULD NOT lives in `security.mdx` (the right home for SSRF-class guidance) rather than in the schema description field.

Surfaced by Python SDK foundation audit on `adcp-client-python#297`, which exports `adcp.signing.DEFAULT_ALLOWED_PORTS = {443, 8443}` as opt-in hardening aligned with this recommendation.

Closes #3555.
