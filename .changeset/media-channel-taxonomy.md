---
"adcontextprotocol": major
---

Add Media Channel Taxonomy specification with standardized channel definitions.

**BREAKING**: Replaces channel enum values (display, video, audio, native, retail → display, olv, social, search, ctv, etc.)

- Introduces 19 planning-oriented media channels representing how buyers allocate budget
- Channels: display, olv, social, search, ctv, linear_tv, radio, streaming_audio, podcast, dooh, ooh, print, cinema, email, gaming, retail_media, influencer, affiliate, product_placement
- Adds desktop_app property type for Electron/Chromium wrapper applications
- Clear distinction between channels (planning abstractions), property types (addressable surfaces), and formats (how ads render)
- Includes migration guide and edge cases documentation
