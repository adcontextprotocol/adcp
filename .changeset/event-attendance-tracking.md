---
"adcontextprotocol": minor
---

Add event attendance tracking and Luma CSV import with contact integration

- Add Community channel for event recaps, photos, and community updates
- Add event_id to perspectives to link content to events
- Add Luma CSV import endpoint for bulk importing event registrations
- Support attendance tracking from Luma check-in data
- Add getEventContent, linkPerspectiveToEvent, and updateRegistration methods
- Create shared contacts-db.ts module with upsertEmailContact for centralized contact handling
- Integrate contact creation into event imports: domain extraction, org auto-matching
- Link event registrations to email_contacts via email_contact_id foreign key
- Refactor webhooks.ts to use shared contacts-db module
