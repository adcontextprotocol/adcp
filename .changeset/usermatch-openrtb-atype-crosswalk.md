---
---

docs(trusted-match): complete the OpenRTB `atype` cross-walk for UserMatch identifiers.

Documents that AdCP `uid_type` is the canonical field and OpenRTB `User.eids[].uids[].atype` is derived by bridge implementations, not carried as an independent AdCP schema field. Completes the person-based `atype: 3` mapping for `id5`, `euid`, and `pairid`, and clarifies that `publisher_first_party` and `other` need out-of-band context.
