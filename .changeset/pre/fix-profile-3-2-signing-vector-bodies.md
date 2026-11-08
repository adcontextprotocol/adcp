---
"adcontextprotocol": patch
---

Give the three hand-authored AdCP 3.2 request-signing vectors (`profile-3.2/positive/001`, `profile-3.2/negative/001` and `profile-3.2/negative/002`) operation-valid `create_media_buy` bodies, re-derive their Content-Digest and signatures, and restore the legacy `positive/002` and `negative/018` bodies #7580 made valid. Each vector keeps its single intended fault. Restore the regression check that every routed signing vector carries an operation-valid body, extended to `profile-3.2/`.
