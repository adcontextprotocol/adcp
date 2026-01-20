---
"adcontextprotocol": major
---

Add Media Channel Taxonomy specification with standardized channel definitions.

**BREAKING**: Replaces channel enum values (display, video, audio, native, retail → web, ctv, mobile_app, social, etc.)

- Introduces 19 media channels (web, ctv, mobile_app, social, search, linear_tv, radio, streaming_audio, podcast, dooh, ooh, print, cinema, email, gaming, influencer, ai_agents, sponsorship, commerce_media)
- Adds desktop_app property type for Electron/Chromium wrapper applications
- Clear distinction between channels (buying context), property types (addressable surfaces), and formats (how ads render)
- Includes migration guide and edge cases documentation
