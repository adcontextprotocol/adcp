---
---

spec(security): rewrite Transport Security from three bullets to full normative floor

The prior Transport Security section was three bullets + an HSTS
snippet. That left operators to reason from first principles about
cipher suites, 0-RTT, session resumption, hostname verification,
outbound-fetch hardening, mTLS header trust, and certificate
validation — each of which has a documented production-compromise
pattern AdCP implementations keep walking into.

Replaces the section with a normative floor covering:

- **TLS version policy.** 1.3 recommended, 1.2 minimum, 1.1 and
  below MUST-reject (including on client-side verifiers fetching
  JWKS / brand.json / revocation lists).
- **Cipher suites.** TLS 1.3 AEAD allowlist. TLS 1.2 restricted to
  AEAD-only ECDHE; CBC-MAC / RC4 / 3DES / NULL / EXPORT / anon DH /
  static RSA MUST be disabled. Server-side cipher ordering MUST be
  preferred so a weak client cannot force a weak suite.
- **Certificate validation (outbound).** Full PKIX. No
  \`verify=False\` / \`rejectUnauthorized: false\`. SAN is
  authoritative; CN-only fallback MUST NOT be accepted. Hostname
  verification MUST be asserted on, not assumed. OCSP stapling
  + must-staple recommended; CT SCT checks on regulated-spend
  endpoints.
- **Inbound server-side headers.** HSTS MUST be ≥ 1 year with
  \`includeSubDomains\`. Adds Referrer-Policy no-referrer, CSP
  \`default-src 'none'; frame-ancestors 'none'\` appropriate for
  JSON-only API endpoints.
- **Client / outbound hardening.** Connection pool caps. 10 s
  handshake / 30 s total timeouts. Pin connection to the IP that
  passed SSRF checks (closes DNS TOCTOU). Refuse redirects on
  JWKS / brand.json / revocation / webhook fetches. Audit
  cross-boundary session resumption.
- **TLS renegotiation and downgrade.** Secure renegotiation only
  (RFC 5746). Compression off (CRIME). Heartbeat off (Heartbleed).
  **0-RTT MUST NOT be enabled on endpoints accepting mutating
  operations** — 0-RTT is replayable by design, and idempotency
  dedup is not a free rescue once the request has hit application
  logic. Discovery endpoints MAY use 0-RTT.
- **mTLS transport.** SAN / Subject is authoritative;
  \`X-Forwarded-Client-Cert\` / \`X-Client-DN\` and siblings are
  explicitly forbidden. Edge-to-server forwarding channel MUST be
  authenticated. Client certs MUST be CRL- or OCSP-checked.
- **Private-network and metadata protection.** TLS does not
  substitute for SSRF controls on counterparty-supplied URLs —
  cross-link to the webhook/JWKS SSRF section.
- **What this section does NOT replace.** Explicit call-out that
  transport security is the floor, not the ceiling: body integrity
  (9421 / webhook-signing), governance attestation, and
  idempotency are separate concerns. This closes the common
  operator failure mode of confusing "modern TLS" with "secure
  AdCP deployment."

No schema change, no new error codes. This is a normative gap-close
on the transport floor that every other security primitive in the
document assumes.
