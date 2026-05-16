---
---

Fix admin "Edit" button silently doing nothing on blog posts in the All Content tab.

`editContent` looked up items only in `myContent` (the user's own posts), but admin items rendered from the All Content tab come from `adminContent`, so the lookup always returned undefined and returned early. Fix: fall back to `adminContent` with type-safe String comparison, fetch full content/tags from `/api/admin/content/:id` before opening the modal (the list endpoint omits these fields), and handle the flat `committee_slug` field that admin list items carry instead of the nested `collection.committee_slug` shape.
