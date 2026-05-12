---
"adcontextprotocol": patch
---

Fix: `save_agent` and `PUT /registry/agents/:url/connect` now reject auth tokens containing NUL, CR, or LF bytes with a clear user-facing message, instead of bubbling a Postgres `invalid byte sequence for encoding "UTF8": 0x00` 500 from the `auth_token_hint` TEXT-column write. The hint generator also sanitizes those characters as defense-in-depth. NUL crashes Postgres TEXT-column writes; CR/LF are HTTP header-injection vectors — neither is legitimate in an Authorization header per RFC 7235.
