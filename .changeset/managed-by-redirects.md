---
"adcontextprotocol": minor
---

Add `authoritative_file` redirect field to adagents.json specification.

Publishers can now delegate their advertising operations to a third-party manager by specifying the full URL of the authoritative adagents.json file. When present, buyer agents should fetch and use the file at this URL instead of the local file.

**New schema field:**
- `authoritative_file` - Optional HTTPS URL pointing to the authoritative adagents.json file

**Why full URLs:**
- Enables property-specific files (e.g., `https://meta.com/.well-known/adagents/instagram.json`)
- Supports both static files and dynamic generation (e.g., `?venue=timessquare`)
- No ambiguity about which file to fetch
- Managers can organize files however they want (path-based, query params, etc.)
- Each property gets a distinct, cacheable URL

**Common use cases:**
- Multi-brand networks (Instagram/Facebook redirect to property-specific Meta files)
- DOOH networks (venues redirect with dynamic generation from database)
- Publisher consortiums (members redirect to per-publisher consortium files)
- White-label platforms (publishers redirect with query-based dynamic generation)

**Schema changes:**
- Added optional `authoritative_file` field with HTTPS URL validation
- Schema now requires EITHER `authorized_agents` OR `authoritative_file` (via oneOf)
- Added three examples: static property-specific file, minimal redirect, dynamic with query params

**Documentation updates:**
- New "Authoritative File Redirects" section explaining full URL approach
- Documented static vs dynamic generation patterns
- Updated Real-World Examples showing Meta with property-specific files
- Added DOOH example with dynamic generation for hundreds of venues
- Security considerations including SSRF protection
