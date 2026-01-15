---
---

fix: Meeting scheduling timezone comparison bug

Fixed Addie incorrectly rejecting meeting times as "already passed" when users
specified times in their local timezone. The datetime comparison now correctly
interprets times in the specified timezone context.
