---
---

Fix owner email showing as "Unknown" on admin members page. The WorkOS API doesn't populate the user object on memberships by default, so we now explicitly fetch user details via getUser() to retrieve the email.
