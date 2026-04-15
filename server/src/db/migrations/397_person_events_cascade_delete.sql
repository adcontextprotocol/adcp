-- When a person_relationships row is merged (deleted), cascade the delete to
-- orphaned person_events rows. The merge code re-parents events first, so this
-- only fires if a concurrent insert sneaks in between the re-parent UPDATE and
-- the DELETE — preventing the FK violation that was crashing user merges.
ALTER TABLE person_events
  DROP CONSTRAINT person_events_person_id_fkey,
  ADD CONSTRAINT person_events_person_id_fkey
    FOREIGN KEY (person_id) REFERENCES person_relationships(id) ON DELETE CASCADE;
