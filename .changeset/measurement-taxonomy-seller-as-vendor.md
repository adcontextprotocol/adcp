---
---

Two doctrinal additions to the measurement taxonomy doc, surfaced from analysis of ChatGPT's ad-serving and attribution architecture in the context of post-#3884 measurement work.

**Closed-loop topologies: seller-as-measurement-agent.** New subsection in the Verification layer naming retail-media closed loop (Walmart Connect, Kroger Precision, Amazon DSP, Criteo Retail Media) and AI-native channels (ChatGPT and agentic-conversation surfaces) as a structurally different topology where the seller is also the measurement vendor — not a degraded case of third-party verification. Documents how the existing primitives (BrandRef, qualifier slot, atomic-unit row shape) handle both topologies cleanly without channel-specific schemas. Notes that the seller-provided merchant-side SDK pattern (OAIQ on advertiser pages for ChatGPT) is the one missing primitive — tracked as #3889.

**Conversation-context targeting open question.** New entry in the Boundaries section's Open Questions area. AI-native channels target using the conversation prompt itself as the targeting signal — closer to walled-garden engagement-signal targeting than traditional contextual. The protocol's existing Signals taxonomy doesn't directly model this; whether it warrants a new signal type or fits within `Contextual signals` is open. Documents the pattern so future signals-layer RFCs have a frame for it.

No schema changes. Doc-only update to keep the taxonomy current with the AI-native channel reality.

References: ChatGPT/OAIQ case study via [www.buchodi.com](https://www.buchodi.com/how-chatgpt-serves-ads-heres-the-full-attribution-loop/); related to #3889 (seller-deployed merchant SDK), #3884 (outcome-measurement unification), #3843 (taxonomy doc).
