---
"adcontextprotocol": minor
---

Add activation key support for signal protocol with permission-based access. Enables signal agents and buyers to receive activation keys (segment IDs or key-value pairs) based on authenticated permissions.

**Breaking Changes:**
- `activate_signal` response: Changed from single `activation_key` field to `deployments` array
- Both `get_signals` and `activate_signal` now consistently use `destinations` (plural)

**New Features:**
- Universal `activation-key.json` schema supporting segment IDs and key-value pairs
- Flexible destination model supporting DSP platforms (string) and sales agents (URL)
- Permission-based key inclusion determined by signal agent authentication
- Buyers with multi-platform credentials receive keys for all authorized platforms

**New Schemas:**
- `activation-key.json` - Universal activation key supporting segment_id and key_value types

**Modified Schemas:**
- `get-signals-request.json` - destinations array with platform OR agent_url
- `get-signals-response.json` - deployments include activation_key when authorized
- `activate-signal-request.json` - destinations array (plural)
- `activate-signal-response.json` - deployments array with per-destination keys

**Security:**
- Removed `requester` flag (can't be spoofed)
- Signal agent validates caller has access to requested destinations
- Permission-based access control via authentication layer
