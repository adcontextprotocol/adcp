---
---

Fix `/member-profile` regressions reported by Evgeny Popov (escalations #330, #331). #330: `updatePhotoPreview()` declared `parsed` as block-scoped `const` inside a try, then used it after — hoisted to `let` above the try. #331: `handleLogoUpload` produced data URLs that the brand-identity endpoint rejected (>2000 char cap + image-fetch validation), and `saveProfile` never sent `photo_url` to any endpoint. Upload now multipart-POSTs to `/api/brands/:domain/logos` for a real hosted URL, and `saveProfile` syncs the result to brand-identity on save. HTML-only; no behavior change to published packages.
