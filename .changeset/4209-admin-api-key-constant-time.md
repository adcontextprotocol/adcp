---
"adcontextprotocol": patch
---

Compare `ADMIN_API_KEY` with `crypto.timingSafeEqual` instead of `===`. Length-mismatch path runs a same-length dummy compare to keep total work constant. `Buffer.from(..., 'latin1')` makes the ASCII-only assumption on the key explicit. Closes #4209.
