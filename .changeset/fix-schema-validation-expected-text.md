---
---

docs(compliance): list all eight required product fields in schema-validation storyboard

The `get_products_schema` step's `expected` description listed only four of the eight required fields in `core/product.json`, leading external implementors to believe their responses were well-formed when they were missing `description`, `publisher_properties`, and `reporting_capabilities`. Updated to enumerate all eight required fields and note that `reporting_capabilities` must be a fully-formed object with its own required sub-fields, not an empty object. No change to validation logic or schema.
