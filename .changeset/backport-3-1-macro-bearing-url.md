---
"adcontextprotocol": patch
---

Backport macro-bearing URL validation from 3.2 to the 3.1 maintenance line so VAST, DAAST, URL, and tracker assets accept ordinary ad-server tokens such as `%%CACHEBUSTER%%`, `%%PATTERN:url%%`, and `%%CLICK_URL_UNESC%%` without pre-encoding their delimiters. Preserve all previously accepted URI-template values and existing substitution semantics. Fixes #7993.
