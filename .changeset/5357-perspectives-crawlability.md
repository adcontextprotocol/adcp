---
---

website: make published Perspectives discoverable to crawlers.

Adds dynamic `/llms.txt` and `/.well-known/llms.txt` responses that list published editorial Perspectives, plus `/perspectives/feed.xml` as an RSS feed with title, URL, author, publication date, and excerpt. The AAO LLM route is registered ahead of static serving, while the AdCP host still falls through to the existing protocol overview file. The RSS route is registered before `/perspectives/:slug` so `feed.xml` is not treated as an article slug.

Replaces the dead dynamic `/robots.txt` handler with a host-aware route registered before static serving, so `agenticadvertising.org` advertises AAO crawl surfaces and `adcontextprotocol.org` advertises AdCP crawl surfaces.

Closes #5357.
