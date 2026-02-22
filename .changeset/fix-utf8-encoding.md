---
"adcontextprotocol": patch
---

Fix UTF-8 encoding corruption for non-ASCII characters in brand and agent registry files.

When external servers serve `.well-known/brand.json` or `.well-known/adagents.json` with a non-UTF-8 charset in their `Content-Type` header (e.g. `charset=iso-8859-1`), axios was decoding the UTF-8 response bytes using that charset, corrupting multi-byte characters like Swedish ä/ö/å into mojibake.

Fix: use `responseType: 'arraybuffer'` on all external fetches so axios delivers raw bytes, then explicitly decode as UTF-8 regardless of what the server declares.
