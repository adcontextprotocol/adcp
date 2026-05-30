---
---

fix(compliance): make `creative_lifecycle` applicable to display-only creative agents.

The generic creative lifecycle storyboard no longer exercises video-specific
creative sync or VAST tag generation. It now syncs and previews a display
creative only. VAST tag generation remains under the existing
`creative-ad-server` specialism where agents explicitly claim that sub-modality.

This prevents display-only creative agents that truthfully advertise no video
formats from failing the baseline `creative_lifecycle` storyboard on
`video_30s` / `vast_30s` requests. The baseline still uses the existing
`display_300x250` sample shape; this change removes the video-specific
applicability failure without adding a one-off test-kit gate or narrowing the
preloaded creative-ad-server specialism.

Closes #4479.
