---
"adcontextprotocol": minor
---

Make brand_manifest optional in get_products and remove promoted_offering.

Sales agents can now decide whether brand context is necessary for product recommendations. This allows for more flexible product discovery workflows where brand information may not always be available or required upfront.

**Schema changes:**
- `get-products-request.json`: Removed `brand_manifest` from required fields array

**Documentation changes:**
- Removed all references to `promoted_offering` field (which never existed in schema)
- Updated all request examples to remove `promoted_offering`
- Updated usage notes and implementation guide to focus on `brief` and `brand_manifest`
- Removed policy checking guidance that was tied to `promoted_offering`
- Fixed schema-documentation mismatch where docs showed `promoted_offering` but schema had `brand_manifest`
