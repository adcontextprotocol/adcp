---
---

Server/dashboard changes: Add Luma integration for AAO events management.

**Luma API Client** (`server/src/luma/client.ts`):
- Full Luma API client with typed interfaces
- Event operations: create, get, update, delete
- Guest/registration operations: list guests, approve, decline, check-in
- Calendar operations: list calendars, list calendar events
- Webhook payload parsing and validation

**Luma Webhook Handler** (`POST /api/webhooks/luma`):
- Handles `guest.created` - Syncs new registrations from Luma to AAO database
- Handles `guest.updated` - Updates registration status (approved/declined/checked-in)
- Handles `event.updated` - Syncs event changes from Luma back to AAO

**Addie Event Tools** for natural language event management:
- `create_event` - Create events in both Luma and AAO database
- `list_upcoming_events` - List upcoming events with filtering
- `get_event_details` - Get event details with registration counts
- `manage_event_registrations` - List, approve waitlist, export registrations
- `update_event` - Update event details

**Admin Navigation**:
- Added "Events" link to admin sidebar in the Community section

Requires `LUMA_API_KEY` environment variable for Luma integration.
