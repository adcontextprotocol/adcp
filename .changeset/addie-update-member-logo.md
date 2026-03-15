---
---

Complete member profile management pathways:
- Add `update_member_logo` admin tool to Addie for setting/updating logo URLs in hosted brand entries
- Add `update_member_profile` admin tool to Addie for updating profile fields (description, tagline, contact info, social links, visibility)
- Add self-serve brand identity editing: PUT /api/me/member-profile/brand-identity endpoint + inline edit forms in member profile page
- Members with existing brands can edit logo URL and brand color inline; members without brands get a quick setup form
