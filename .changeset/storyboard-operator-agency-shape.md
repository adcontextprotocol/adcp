---
---

Storyboard hygiene — property-lists and collection-lists specialism scenarios had `operator` equal to the brand's own domain (`acmeoutdoor.example`, `novamotors.example`), modeling a direct-operated buyer. Switched to `pinnacle-agency.example` to match the agency-operated pattern used across the rest of the buyer-side storyboards. No runtime behavior change — session scoping on the reference seller is keyed on `brand.domain`, not `operator`.

Closes #2533.
