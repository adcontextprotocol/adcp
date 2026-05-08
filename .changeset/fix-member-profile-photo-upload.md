---
---

Fix member profile photo upload silently failing on save.

Two bugs: `photo_url` was omitted from the profile save call so uploads were
silently dropped; and a `const parsed` declared inside a `try` block was
referenced outside it, causing `ReferenceError: parsed is not defined` on any
profile that already had a photo URL. Also allows data-URL previews to render
after a file upload.
