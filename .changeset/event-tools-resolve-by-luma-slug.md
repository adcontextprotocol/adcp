---
---

Addie's event tools (`list_event_attendees`, `get_event_details`, `manage_event_registrations`, `update_event`, `register_event_interest`, `check_person_event_status`, `add_event_invite`) now accept any user-facing event identifier — internal slug, UUID, Luma api_id, full Luma URL (`https://luma.com/0zarmldc`), Luma URL slug, or a unique title fragment. Previously, passing a Luma URL slug threw `invalid input syntax for type uuid` from the unguarded id-lookup path, which surfaced to the user as a misleading "admin access wall".

Factored the repeated lookup into a single `resolveEvent()` helper that tries internal slug → internal UUID (UUID-shape gated) → `luma_event_id` → `luma_url` trailing path → fuzzy title match. Tool input descriptions updated to reflect the accepted forms so the model picks the right tool without asking the user to disambiguate identifier types. Adds `EventsDatabase.getEventByLumaUrlSlug()` and `findEventByTitleFuzzy()`.
