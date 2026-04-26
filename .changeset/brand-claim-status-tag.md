---
---

Prefix brand-claim chat tool responses with an HTML comment `<!-- STATUS: <code> -->` (invisible in rendered markdown, parseable by the LLM) so the model can branch on a stable signal instead of pattern-matching prose. Covers happy paths (dns_record_issued, already_verified, verified) and rejection paths (collision, invalid_domain, still_pending, no_challenge, workos_error, not_authenticated, no_org, not_admin, missing_domain).
