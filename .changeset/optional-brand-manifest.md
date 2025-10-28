---
"adcontextprotocol": minor
---

Make brand_manifest optional in get_products request.

Sales agents can now decide whether brand context is necessary for product recommendations. This allows for more flexible product discovery workflows where brand information may not always be available or required upfront.

**Schema changes:**
- `get-products-request.json`: Removed `brand_manifest` from required fields array
- Documentation updated to clarify brand_manifest is optional
