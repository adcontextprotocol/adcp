---
"adcontextprotocol": patch
---

Docs: state the rules for what changes between releases at the top of the versioning page. A minor only adds, a replaced field is emitted alongside its replacement until the next major, and removals and breaking changes happen in a major. Removes text from that page that told SDKs what to do or described translating between versions, and corrects one sentence in the `create_media_buy` reference that said new keys could join a closed schema in a minor. Wire behavior is unchanged.
