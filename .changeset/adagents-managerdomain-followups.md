---
---

Follow-up to PR #4173 (ads.txt managerdomain fallback) addressing reviewer asks from @bokelley:

- **Structured `discovery_method` field** — `AdAgentsValidationResult` now carries `discovery_method: 'direct' | 'authoritative_location' | 'ads_txt_managerdomain'` and, when discovery used a manager, `manager_domain: string`. Buyers and downstream consumers can now weight results differently without parsing warning strings.
- **IAB directive form only** — the `# managerdomain=` comment-prefix form is no longer accepted. Standard `MANAGERDOMAIN=example.com` directives only, per IAB ads.txt 1.1. Avoids treating publisher notes-to-self as live delegations.
- **Explicit IAB divergence doc** — docs now state that AdCP's fail-closed behavior on multiple `MANAGERDOMAIN` entries (vs. IAB's last-wins) is intentional: a wrong manager selection would silently authorize an incorrect agent across the publisher's entire inventory.
- **ads.txt cache** — `tryResolveManagerDomains` now caches per-host with a 4-hour TTL for successful fetches and 1-hour TTL for 404/error, preventing amplification on repeated publisher 404s.
