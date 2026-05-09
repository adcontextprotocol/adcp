---
---

Tighten `assertClaimableBrandDomain`: add social/profile platforms (linkedin.com, twitter.com, x.com, facebook.com, instagram.com, youtube.com, tiktok.com, reddit.com, etc.) to `SHARED_PLATFORM_DOMAINS`, and add a new `SHARED_PLATFORM_SUFFIXES` matcher for shared SaaS subdomain hosts (hubspotusercontent.com, amazonaws.com, atlassian.net, force.com, myshopify.com, etc.). Catches the `linkedin.com` and HubSpot CDN URL classes that were stored as brand-primary in the wild. Adds two more per-case fixes to `stage0-domain-cleanup` for the orgs that already had those values stored: Mogl (reset to mogl.com) and No Fluff Advisory (reset to signal-stack.io + canonicalize the org_domains www. row).
