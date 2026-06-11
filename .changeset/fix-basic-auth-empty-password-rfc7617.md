---
---

fix(server): accept RFC 7617 Basic auth credentials with empty passwords

Stored HTTP Basic credentials now enforce a non-empty user-id without rejecting
valid `user:` credentials whose password is empty.
