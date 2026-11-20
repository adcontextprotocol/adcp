---
"adcontextprotocol": patch
---

Apply the requirements schema for an offering asset group's `asset_type` to its `asset_requirements`. `core/requirements/offering-asset-constraint.json` now pairs each of the 12 asset types that have a requirements schema with that schema, as the `asset-requirements.json` description already said. Before, the 12-branch union accepted any object, because every branch accepts `{}`. Asset types without a requirements schema keep the union. (#8476)
