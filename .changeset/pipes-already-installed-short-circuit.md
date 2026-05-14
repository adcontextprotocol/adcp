---
---

fix(server): `/connect/github` and the Member Hub Connect button now precheck the user's existing Pipes token state before calling WorkOS authorize. Already-connected users get sent straight to `returnTo` instead of receiving a 502/error page driven by WorkOS' `400 "User has already installed this integration"` response. Recovers from the same 400 if it slips through (TOCTOU between the token check and the authorize POST).
