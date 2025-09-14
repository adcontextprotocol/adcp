---
sidebar_position: 2
title: activate_signal
---

# activate_signal

**Task**: Activate a signal for use on a specific platform/account.

**Response Time**: Minutes to days (asynchronous with potential human-in-the-loop)

**Request Schema**: [`/schemas/v1/signals/activate-signal-request.json`](/schemas/v1/signals/activate-signal-request.json)  
**Response Schema**: [`/schemas/v1/signals/activate-signal-response.json`](/schemas/v1/signals/activate-signal-response.json)

The `activate_signal` task handles the entire activation lifecycle, including:
- Initiating the activation request
- Monitoring activation progress
- Returning the final deployment status

## Request Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `signal_agent_segment_id` | string | Yes | The universal identifier for the signal to activate |
| `platform` | string | Yes | The target platform for activation |
| `account` | string | No* | Account identifier (required for account-specific activation) |

*Required when activating at account level

## Response (Message)

The response includes a human-readable message that:
- Confirms activation was initiated with estimated timing
- Provides progress updates during processing
- Explains successful deployment with segment ID
- Describes any errors and remediation steps

The message is returned differently in each protocol:
- **MCP**: Returned as a `message` field in the JSON response
- **A2A**: Returned as a text part in the artifact

## Response (Payload)

```json
{
  "task_id": "string",
  "status": "string",
  "decisioning_platform_segment_id": "string",
  "estimated_activation_duration_minutes": "number",
  "deployed_at": "string",
  "error": {
    "code": "string",
    "message": "string"
  }
}
```

### Field Descriptions

- **task_id**: Unique identifier for tracking the activation
- **status**: Current status (pending, processing, deployed, failed)
- **decisioning_platform_segment_id**: The platform-specific ID to use once activated
- **estimated_activation_duration_minutes**: Estimated time to complete (optional)
- **deployed_at**: Timestamp when activation completed (optional)
- **error**: Error details if activation failed (optional)
  - **code**: Error code for programmatic handling
  - **message**: Detailed error message

## Protocol-Specific Examples

The AdCP payload is identical across protocols. Only the request/response wrapper differs.

### MCP Request
```json
{
  "tool": "activate_signal",
  "arguments": {
    
    "signal_agent_segment_id": "luxury_auto_intenders",
    "platform": "the-trade-desk",
    "account": "agency-123-ttd"
  }
}
```

### MCP Response (Asynchronous)
Initial response:
```json
{
  "message": "Initiating activation of 'Luxury Auto Intenders' on The Trade Desk",
  "context_id": "ctx-signals-123",
  "task_id": "activation_789",
  "status": "pending",
  "decisioning_platform_segment_id": "ttd_agency123_lux_auto",
  "estimated_activation_duration_minutes": 30
}
```

After polling for completion:
```json
{
  "message": "Signal successfully activated on The Trade Desk",
  "context_id": "ctx-signals-123",
  "task_id": "activation_789",
  "status": "deployed",
  "decisioning_platform_segment_id": "ttd_agency123_lux_auto",
  "deployed_at": "2024-01-15T14:30:00Z"
}
```

### A2A Request

#### Natural Language Invocation
```javascript
await a2a.send({
  message: {
    parts: [{
      kind: "text",
      text: "Please activate the luxury_auto_intenders signal on The Trade Desk for account agency-123-ttd."
    }]
  }
});
```

#### Explicit Skill Invocation
```javascript
await a2a.send({
  message: {
    parts: [{
      kind: "data",
      data: {
        skill: "activate_signal",
        parameters: {
          signal_agent_segment_id: "luxury_auto_intenders",
          platform: "the-trade-desk",
          account: "agency-123-ttd"
        }
      }
    }]
  }
});
```

### A2A Response (with streaming)
Initial response:
```json
{
  "taskId": "task-signal-001",
  "status": { "state": "working" }
}
```

Then via Server-Sent Events:
```
data: {"message": "Validating signal access permissions..."}
data: {"message": "Configuring deployment on The Trade Desk..."}
data: {"message": "Finalizing activation..."}
data: {"status": {"state": "completed"}, "artifacts": [{
  "name": "signal_activation_result",
  "parts": [
    {"kind": "text", "text": "Signal successfully activated on The Trade Desk"},
    {"kind": "data", "data": {
      "status": "deployed",
      "decisioning_platform_segment_id": "ttd_agency123_lux_auto",
      "deployed_at": "2024-01-15T14:30:00Z"
    }}
  ]
}]}
```

### Key Differences
- **MCP**: Returns task_id for polling asynchronous operations
- **A2A**: Always async with real-time progress updates via SSE
- **Payload**: The `input` field in A2A contains the exact same structure as MCP's `arguments`

## Scenarios

### Initial Response (Pending)
**Message**: "I've initiated activation of 'Luxury Automotive Context' on PubMatic for account brand-456-pm. This typically takes about 60 minutes. I'll monitor the progress and notify you when it's ready to use."

**Payload**:
```json
{
  "task_id": "activation_12345",
  "status": "pending",
  "decisioning_platform_segment_id": "pm_brand456_peer39_lux_auto",
  "estimated_activation_duration_minutes": 60
}
```

### Status Update (Processing)
**Message**: "Good progress on the activation. Access permissions validated successfully. Now configuring the signal deployment on PubMatic's platform. About 45 minutes remaining."

**Payload**:
```json
{
  "task_id": "activation_12345",
  "status": "processing"
}
```

### Final Response (Deployed)
**Message**: "Excellent! The 'Luxury Automotive Context' signal is now live on PubMatic. You can start using it immediately in your campaigns with the ID 'pm_brand456_peer39_lux_auto'. The activation completed faster than expected - just 52 minutes."

**Payload**:
```json
{
  "task_id": "activation_12345",
  "status": "deployed",
  "decisioning_platform_segment_id": "pm_brand456_peer39_lux_auto",
  "deployed_at": "2025-01-15T14:30:00Z"
}
```

### Error Response (Failed)
**Message**: "I couldn't activate the signal on PubMatic. Your account 'brand-456-pm' doesn't have permission to use Peer39 data. Please contact your PubMatic account manager to enable Peer39 access, then we can try again."

**Payload**:
```json
{
  "task_id": "activation_12345",
  "status": "failed",
  "error": {
    "code": "DEPLOYMENT_UNAUTHORIZED",
    "message": "Account brand-456-pm not authorized for Peer39 data on PubMatic"
  }
}
```

## Status Values

- **pending**: Activation request received and queued
- **processing**: Activation in progress
- **deployed**: Signal successfully activated and ready to use
- **failed**: Activation failed (see error message for details)

## Error Codes

- `SIGNAL_AGENT_SEGMENT_NOT_FOUND`: Signal agent segment ID doesn't exist
- `ACTIVATION_FAILED`: Could not activate signal
- `ALREADY_ACTIVATED`: Signal already active
- `DEPLOYMENT_UNAUTHORIZED`: Can't deploy to platform/account
- `INVALID_PRICING_MODEL`: Pricing model not available

## Usage Notes

1. **Account-Specific**: Include the `account` parameter for account-specific activations
2. **Platform-Wide**: Omit the `account` parameter for platform-wide activations
3. **Async Operation**: This is a long-running task that provides status updates
4. **Monitoring**: Use task ID to monitor progress via polling or SSE
5. **Idempotent**: Safe to retry if activation fails

## Implementation Guide

### Generating Activation Messages

The `message` field should provide clear status updates and actionable information:

```python
def generate_activation_message(status, signal_info, request):
    if status == "pending":
        return f"I've initiated activation of '{signal_info.name}' on {request.platform} for account {request.account}. This typically takes about {signal_info.estimated_duration} minutes. I'll monitor the progress and notify you when it's ready to use."
    
    elif status == "processing":
        progress_details = get_progress_details()
        time_remaining = calculate_time_remaining()
        return f"Good progress on the activation. {progress_details}. About {time_remaining} minutes remaining."
    
    elif status == "deployed":
        actual_duration = calculate_actual_duration()
        timing_note = "faster than expected" if actual_duration < signal_info.estimated_duration else "as expected"
        return f"Excellent! The '{signal_info.name}' signal is now live on {request.platform}. You can start using it immediately in your campaigns with the ID '{signal_info.platform_id}'. The activation completed {timing_note} - just {actual_duration} minutes."
    
    elif status == "failed":
        error_explanation = explain_error_in_context(error_code)
        next_steps = get_remediation_steps(error_code)
        return f"I couldn't activate the signal on {request.platform}. {error_explanation}. {next_steps}"
```