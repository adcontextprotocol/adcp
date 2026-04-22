---
---

Fix C2PA signing failures when Gemini's image model returns a non-PNG variant (webp/jpeg), which c2pa-node rejects with "type is unsupported". Both the illustration generator (`attachC2PAIfEnabled`) and the docs-storyboard build script (`scripts/generate-images.ts`) now re-encode the buffer through sharp with `failOn: 'error'` + `.rotate()` before signing, so the bytes match the `image/png` mimeType declared to the signer and any upstream EXIF/XMP metadata is stripped (the C2PA manifest is the sole provenance source of truth). The portrait path already normalized via sharp as part of the AI-badge composite, so this brings the three generator paths into alignment.
