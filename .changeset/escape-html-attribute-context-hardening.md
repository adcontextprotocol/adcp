---
---

`escapeHtml` helpers in 63 server/public HTML pages now escape `"` and `'` in addition to `<>&`, so values interpolated into HTML attribute contexts (`src="${escapeHtml(...)}"`, `data-*` attrs, etc.) can't break out of the attribute even if upstream validation lets a quote through. Defense-in-depth for #3153.

The `div.textContent → div.innerHTML` round-trip historically only escaped `<>&`, leaving the helper unsafe for the dominant call site (HTML attributes in template literals). Pages that already used a manual `replace()` chain were already safe and weren't touched.

Behavior change for callers: text content with quotes now renders with `&quot;` / `&#39;` entities — visually identical in browsers, byte-different in inspect-element. The `tests/community/profile-edit.test.ts` assertion was updated accordingly.
