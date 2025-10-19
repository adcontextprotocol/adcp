---
---

Fix documentation-schema mismatch for format render dimensions.

Documentation incorrectly showed top-level `render_dimensions` field, but the actual schema uses `renders` array with nested `dimensions`. Updated docs/creative/formats.md, CLAUDE.md, and schema registry changelog to match the correct schema structure that supports both single and multi-render formats (companion ads, adaptive formats).