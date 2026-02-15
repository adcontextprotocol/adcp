-- Keep Addie current on formal AdCP agent types
-- These change over time and her training data lags

INSERT INTO addie_rules (rule_type, name, description, content, priority, created_by) VALUES
(
  'knowledge',
  'AdCP Agent Types',
  'Current list of formal AdCP agent types',
  'The formal AdCP agent types are:
- **Sales** — publisher-side inventory discovery and media buying
- **Creative** — creative asset generation, format listing, preview rendering
- **Signals** — audience signals discovery and activation
- **Governance** — property lists (where ads run) and content standards (brand suitability)
- **SI (Sponsored Intelligence)** — commerce-oriented sponsored placements

All of these are first-class agent types with their own tools and documentation in docs/. Use search_docs to look up details rather than answering from memory, especially for newer agent types.

Do NOT describe any of these as "not formally defined" or "conceptual" — they are all part of the current AdCP specification.',
  170,
  'system'
);
