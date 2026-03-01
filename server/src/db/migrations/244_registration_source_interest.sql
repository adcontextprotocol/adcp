ALTER TABLE event_registrations
  DROP CONSTRAINT IF EXISTS event_registrations_registration_source_check;
ALTER TABLE event_registrations
  ADD CONSTRAINT event_registrations_registration_source_check
  CHECK (registration_source IN ('direct', 'luma', 'import', 'admin', 'interest'));
