---
"adcontextprotocol": patch
---

Refactor signals schemas to use reusable core destination and deployment schemas.

**Changes:**
- Created `/schemas/v1/core/destination.json` - reusable schema for signal activation destinations (DSPs, sales agents, etc.)
- Created `/schemas/v1/core/deployment.json` - reusable schema for signal deployment status and activation keys
- Updated all signals task schemas to reference the new core schemas instead of duplicating definitions
- Added destination and deployment to schema registry index

**Benefits:**
- Eliminates schema duplication across 4 signal task schemas
- Ensures consistent validation of destination and deployment objects
- Improves type safety - single source of truth for these data structures
- Simplifies maintenance - changes to destination/deployment structure only need updates in one place

**Affected schemas:**
- `get-signals-request.json` - destinations array now uses `$ref` to core destination schema
- `get-signals-response.json` - deployments array now uses `$ref` to core deployment schema
- `activate-signal-request.json` - destinations array now uses `$ref` to core destination schema
- `activate-signal-response.json` - deployments array now uses `$ref` to core deployment schema

This is a non-breaking change - the validation behavior remains identical, only the schema structure is improved.
