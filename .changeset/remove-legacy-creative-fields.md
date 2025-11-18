---
"adcontextprotocol": minor
---

Remove unused legacy fields from list_creatives response schema.

**Fields removed:**
- `media_url` - URL of the creative file
- `click_url` - Landing page URL
- `duration` - Duration in milliseconds
- `width` - Width in pixels
- `height` - Height in pixels

**Why this is a minor change (not breaking):**

These fields were never implemented or populated by any AdCP server implementation. They existed in the schema from the initial creative library implementation but were non-functional. All creative metadata is accessed through the structured `assets` dictionary, which has been the only working approach since AdCP v2.0.

**Migration:**

No migration needed - if you were parsing these fields, they were always empty/null. Use the `assets` dictionary to access creative properties:

```json
{
  "creative_id": "hero_video_30s",
  "assets": {
    "vast": {
      "url": "https://vast.example.com/video/123",
      "vast_version": "4.1"
    }
  }
}
```

All creative asset metadata (URLs, dimensions, durations, click destinations) is contained within the typed asset objects in the `assets` dictionary.
