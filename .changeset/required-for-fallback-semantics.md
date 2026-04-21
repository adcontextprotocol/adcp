---
---

Formalize `required_for` composition with fallback authenticators. Clarifies that `required_for` rejects unsigned requests only when the caller presents no other valid credential (bearer, API key, mTLS); unsigned-but-bearer-authed calls remain accepted unless the seller disables bearer for the operation. Adds a new "Composition with fallback authenticators" subsection to the request-signing spec and updates the `required_for` capability definition with a cross-reference. Closes #2586.
