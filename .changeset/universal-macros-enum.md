---
"adcontextprotocol": minor
---

Add universal macro enum schema and improve macro documentation

Schema:
- Add universal-macro.json enum defining all 54 standard macros with descriptions
- Update format.json supported_macros to reference enum (backward compatible via oneOf)
- Update webhook-asset.json supported_macros and required_macros to reference enum
- Register universal-macro enum in schema index

New Macros:
- GPP_SID: Global Privacy Platform Section ID(s) for privacy framework identification
- IP_ADDRESS: User IP address with privacy warnings (often masked/restricted)
- STATION_ID: Radio station or podcast identifier
- SHOW_NAME: Program or show name
- EPISODE_ID: Podcast episode identifier
- AUDIO_DURATION: Audio content duration in seconds

Documentation:
- Add GPP_SID to Privacy & Compliance Macros section
- Add IP_ADDRESS with privacy warning callout
- Add Audio Content Macros section for audio-specific macros
- Add TIMESTAMP to availability table
- Add GPP_STRING and GPP_SID to availability table
- Add IP_ADDRESS to availability table with privacy restriction notation (✅‡)
- Add Audio Content macros to availability table
- Update legend with ✅‡ notation for privacy-restricted macros
