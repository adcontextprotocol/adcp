---
"adcontextprotocol": patch
---

Compliance corpus: `profile-3.2/` now mirrors every remaining root request-signing vector except `negative/018`, so a `covers_content_digest: "required"` verifier, which is every 3.2+ verifier, can grade them. The new negatives are `001`, `011`, `019`, `021`, `022`, `023`, `024`, `026`, `027`, `028`, `029`, `030` and `031`, and the new positive guards are `013`, `014` and `015`. Each mirror keeps its root number, slug and expected code, covers `content-digest` wherever a `Signature-Input` exists, and carries a correct `Content-Digest`, so the step-0/1 fault is the vector's only fault. `negative/018` stays unmirrored because `forbidden` is illegal in 3.2. The vector README now requires every vector to carry exactly one fault (adcp#7577). No normative change.
