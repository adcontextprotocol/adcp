---
"adcontextprotocol": patch
---

Extract shared PriceGuidance schema to fix duplicate type generation

**Schema Changes:**
- Create new `/schemas/pricing-options/price-guidance.json` shared schema
- Update all 7 pricing option schemas to use `$ref` instead of inline definitions

**Issue Fixed:**
- Fixes #884 (Issue 1): Duplicate `PriceGuidance` classes causing mypy arg-type errors
- When Python types are generated, there will now be a single `PriceGuidance` class instead of 7 identical copies

**Note:** Issue 2 (RootModel wrappers) requires Python library changes to export type aliases for union types.
