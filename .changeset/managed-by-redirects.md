---
"adcontextprotocol": minor
---

Add `authoritative_file` redirect field to adagents.json specification.

Publishers can now delegate their **entire adagents.json file** (properties + authorization) to a third-party manager by specifying the full URL where the complete, authoritative file is hosted. When present, buyer agents should fetch and use that file instead of the local file - replacing both the property list and the authorized agents.

**New schema field:**
- `authoritative_file` - Optional HTTPS URL pointing to the authoritative adagents.json file

**Why full URLs:**
- Enables property-specific files (e.g., `https://meta.com/.well-known/adagents/instagram.json`)
- Supports both static files and dynamic generation (e.g., `?venue=timessquare`)
- No ambiguity about which file to fetch
- Managers can organize files however they want (path-based, query params, etc.)
- Each property gets a distinct, cacheable URL

**Common use cases (ownership/management delegation):**
- Multi-brand corporations (Instagram/Facebook owned by Meta delegate complete file to Meta)
- Subsidiary relationships (local news sites delegate complete file to parent media company)
- Publisher consortiums (member publishers delegate to centralized management)
- Ad server / platform hosting (publisher's properties and authorization managed by their ad server/SSP)
- White-label platforms (publishers using platform delegate complete file to platform provider)

**NOT for (use standard authorization patterns instead):**
- Sales representation (e.g., DOOH networks selling venues they don't own)
- Ad network relationships (use authorized_agents, not delegation)

**Schema changes:**
- Added optional `authoritative_file` field with HTTPS URL validation
- Schema now requires EITHER `authorized_agents` OR `authoritative_file` (via oneOf)
- Added three examples: static property-specific file, minimal redirect, dynamic with query params

**Documentation updates:**
- New "Authoritative File Redirects" section explaining full URL approach
- Clear distinction: ownership/management delegation vs sales representation
- Updated Real-World Examples showing Meta with property-specific files
- Added subsidiary relationship example (regional media company with local news sites)
- Added DOOH counter-example showing proper sales representation pattern (NO delegation)
- Security considerations including SSRF protection

**Key insight from ads.txt:** Like MANAGERDOMAIN, `authoritative_file` is about **business relationships** (who manages the file), not just technical redirection. Unlike MANAGERDOMAIN, it provides actual delegation with property-specific files instead of just metadata.

**Critical understanding:** The authoritative file replaces the ENTIRE local file - both properties and authorized_agents. This is especially powerful for platform/ad server hosting, where the property list comes from the same database as ad serving, ensuring single source of truth.
