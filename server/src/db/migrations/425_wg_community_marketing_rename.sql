-- Address feedback on the WG consolidation:
--   - "Community & Events" undersells the group's scope (marketing, content,
--     PMM, education are equally active). Rename to "Community & Marketing"
--     and expand the description to list every stream.
--   - Creative's description used "governance" which collides with the
--     separate Governance WG. Swap to "review & approvals", which is what
--     creative governance actually means.

UPDATE working_groups SET
  name = 'Community & Marketing',
  description = 'Community building, events, marketing, content, education, and thought leadership.'
WHERE slug = 'events-thought-leadership-wg';

UPDATE working_groups SET
  description = 'Creative lifecycle, generative creative, review and approvals.'
WHERE slug = 'creative-wg';
