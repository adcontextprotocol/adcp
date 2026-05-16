---
---

docs(building): fix AAO hallucination + soften framing on sdk-stack page

Two fixes to `docs/building/sdk-stack.mdx`:

1. **AAO expansion fix.** The L2 bullet expanded AAO as "AdCP Authorization Object" linking to a non-existent `/docs/aao` page. AAO is AgenticAdvertising.org. Rewrote the bullet to describe what the SDK's AAO bridge actually resolves (member org, AAO Verified badges, registry visibility) with links to the registry and AAO Verified pages.

2. **Reframed the intro and the "early implementers" section.** The opening previously called out "two audiences arriving at the same wrong conclusion" and the later section was titled "What early implementers underestimate" — both read as telling the reader they're wrong before laying out the data. Reframed around the actual choice — *where do you want to spend your engineering time?* — so the cost decompositions later in the page do the persuasion. Also softened the order-of-magnitude line and the TL;DR closer.

3. **Named Python + TypeScript as first-class languages and added a contribution CTA.** Above the SDK coverage snapshot, called out that Python and TypeScript are committed to full L0–L4 coverage (TypeScript GA today, Python in flight on 4.x), Go is moving in the same direction, and community-maintained ports for other languages are welcome — with links to the Builders Working Group page and the AgenticAds Slack invite.

4. **Threaded server/client asymmetry through the layer model.** The L0–L4 model previously read as if it described an agent only. Added an intro paragraph naming both sides, *Client side* notes at L0–L4, and a new "Server vs client at each layer" comparison table after L4 showing the cost asymmetry (a from-scratch caller is weeks-to-month at L0–L3; a from-scratch agent is the 3–4 person-month build documented later). Also flagged that the SDK coverage checklist describes the server surface and named the parallel client-side primitives an SDK should ship.
