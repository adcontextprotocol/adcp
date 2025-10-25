---
"adcontextprotocol": minor
---

Add universal namespace for signals with structured signal IDs.

Signals now use a structured identifier similar to creative formats, enabling cross-agent signal references and avoiding collisions:

**New schemas:**
- `signal-id.json` core schema (agent_url + id pattern)

**Updated schemas:**
- `get-signals-response.json`: Replace `signal_agent_segment_id` (string) with `signal_id` (structured object)
- `activate-signal-request.json`: Replace `signal_agent_segment_id` (string) with `signal_id` (structured object)
- `get-signals-request.json`: Add optional `signal_ids` filter for querying specific signals

**Documentation updates:**
- Updated all examples to use structured signal_id format
- Updated error codes: `SIGNAL_AGENT_SEGMENT_NOT_FOUND` → `SIGNAL_NOT_FOUND`

**Example signal ID:**
```json
{
  "agent_url": "https://liveramp.com",
  "id": "cats-that-use-ai"
}
```

This enables confident cross-platform references like "Do you have the LiveRamp cats-that-use-ai segment?"
