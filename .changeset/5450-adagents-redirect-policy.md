---
"adcontextprotocol": minor
---

Define adagents.json discovery redirect policy and reconcile the reference implementation with it.

The initial `/.well-known/adagents.json` fetch now follows **same-registrable-domain** redirects (apex↔www, HTTPS-preserving, ≤3 hops, SSRF re-validated per hop, anchored on the originally-requested domain) so that standard apex→www managed hosting resolves instead of being silently reported unauthorized. **Cross-registrable-domain** redirects are refused — declare delegation with `authoritative_location` instead — and the `authoritative_location` dereference continues to refuse all redirects. Docs: managed-networks "Why not HTTP redirects?" and L1 security SSRF/TLS-hardening sections; new conformance vectors in `static/test-vectors/adagents-discovery-redirects.json`.
