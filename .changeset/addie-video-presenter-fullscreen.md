---
---

Add presenter mode and fullscreen toggle to `/video` so the standalone Addie video page can be projected at events without browser chrome.

- `?presenter=1` hides the page header and removes padding so the iframe takes the full viewport.
- New "Fullscreen" button next to "End conversation" requests fullscreen on the document. `F` keyboard shortcut also toggles fullscreen during an active call.
- `:fullscreen` CSS rules strip the header and padding while in fullscreen, so the projector shows only Addie regardless of how fullscreen was entered.
- `allowfullscreen` added to the call iframe so the embedded Tavus/Daily UI can also fullscreen its own video element.
