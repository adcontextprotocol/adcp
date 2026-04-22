---
---

Surface the adoption path for coding agents and a publisher/seller entry point, without a marketing landing page.

- **`docs/quickstart.mdx`** — two-path `<CardGroup>` at the fold so publisher/seller readers ("I'm building an agent") don't bounce before finding `build-an-agent`. Buyer path stays at `#setup` and is unchanged below the fold.
- **`server/public/llms.txt`** — adds an Adoption path section (quickstart → build → validate → operate + direct SKILL.md URL), an SDKs and skills section (both-sides framing), and a Registry APIs section. Points coding agents at the shortest route from discovery to a working implementation.
- **`server/public/llms-full.txt`** — same reframe: Getting started becomes an explicit four-step adoption path, plus full SDK inventory, all eight `build-*-agent` skills with what each targets, and the Registry APIs. Both-sides SDK framing matches the llms.txt.

Deliberately excludes the `docs/trust.mdx` landing page and "Trust and safety" block that were in #2814 — those are tracked for rewrite in #2817 because the draft framing contradicted this release's self-attested/known-limitations posture. This PR is the small, low-risk subset.
