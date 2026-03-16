---
---

fix: restore versioned docs and repair broken links

Replaced blanket `dist/` in .mintignore with granular ignores so versioned doc
snapshots (2.5.3, 3.0.0-rc.2, etc.) are served by Mintlify again. Fixed 18
broken internal links where list_creative_formats and sync_creatives moved from
media-buy/task-reference/ to creative/task-reference/ in v3. Removed incorrect
Documentation wrapper group from non-default version nav configs.
