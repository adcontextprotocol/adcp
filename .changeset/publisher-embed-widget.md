---
---

New partner-storefront embed widget at `GET /publisher/:domain/embed`. Closes the highest-leverage gap product reviewer flagged on the canonical page redesign: partner sites can now iframe AAO publisher status into their own UI without sending users away. The widget shares data with the canonical page (calls the same `/api/registry/publisher`) but strips the global nav, breadcrumb, contextual line, and cross-link footer. The verifier-grade hero (state pill + verification chrome with timestamp / HTTP / origin URL + freshness pill) and a condensed counts panel ship in the embed. Footer carries a "View on AgenticAdvertising.org" canonical link plus a "Powered by AAO" mark.

Route sets `Content-Security-Policy: frame-ancestors *` so any partner site can frame it, and a 5-minute `Cache-Control: public, max-age=300`. Registered before the existing `/publisher/*domain` wildcard so the canonical full-page route stays intact.
