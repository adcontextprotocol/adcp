---
"adcontextprotocol": patch
---

docs(creative-channels): replace invalid `"url_type": "tracker"` with `"url_type": "tracker_pixel"` in display, audio, carousels, and DOOH channel docs to match the `url-asset-type.json` enum (`clickthrough` / `tracker_pixel` / `tracker_script`). Addresses adcp#2986 step 1 (3.0.x docs cleanup). Wire format unchanged — the published schema enum already excluded `"tracker"`, so the channel docs were emitting an invalid value sellers could not validate against.
