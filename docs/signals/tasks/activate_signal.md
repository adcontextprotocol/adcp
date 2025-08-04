---
sidebar_position: 2
title: activate_signal
---

# activate_signal

**Task**: Activate a signal for use on a specific platform/account.

The `activate_signal` task handles the entire activation lifecycle, including:
- Initiating the activation request
- Monitoring activation progress
- Returning the final deployment status

## Request

```json
{
  "context_id": "ctx-signals-abc123",  // From previous get_signals call
  "signal_agent_segment_id": "peer39_luxury_auto",
  "platform": "pubmatic",
  "account": "brand-456-pm"
}
```

### Parameters

- **context_id** (string, required): Context identifier from previous get_signals call
- **signal_agent_segment_id** (string, required): The universal identifier for the signal to activate
- **platform** (string, required): The target platform for activation
- **account** (string, optional): Required for account-specific activation

## Response

The task provides status updates as the activation progresses:

### Initial Response (immediate)

```json
{
  "message": "I've initiated activation of 'Luxury Automotive Context' on PubMatic for account brand-456-pm. This typically takes about 60 minutes. I'll monitor the progress and notify you when it's ready to use.",
  "context_id": "ctx-signals-abc123",
  "task_id": "activation_12345",
  "status": "pending",
  "decisioning_platform_segment_id": "pm_brand456_peer39_lux_auto",
  "estimated_activation_duration_minutes": 60
}
```

### Status Updates (streamed or polled)

```json
{
  "message": "Good progress on the activation. Access permissions validated successfully. Now configuring the signal deployment on PubMatic's platform. About 45 minutes remaining.",
  "context_id": "ctx-signals-abc123",
  "task_id": "activation_12345",
  "status": "processing"
}
```

### Final Response (when complete)

```json
{
  "message": "Excellent! The 'Luxury Automotive Context' signal is now live on PubMatic. You can start using it immediately in your campaigns with the ID 'pm_brand456_peer39_lux_auto'. The activation completed faster than expected - just 52 minutes.",
  "context_id": "ctx-signals-abc123",
  "task_id": "activation_12345",
  "status": "deployed",
  "decisioning_platform_segment_id": "pm_brand456_peer39_lux_auto",
  "deployed_at": "2025-01-15T14:30:00Z"
}
```

### Error Response

```json
{
  "message": "I couldn't activate the signal on PubMatic. Your account 'brand-456-pm' doesn't have permission to use Peer39 data. Please contact your PubMatic account manager to enable Peer39 access, then we can try again.",
  "context_id": "ctx-signals-abc123",
  "task_id": "activation_12345",
  "status": "failed",
  "error": {
    "code": "DEPLOYMENT_UNAUTHORIZED",
    "message": "Account brand-456-pm not authorized for Peer39 data on PubMatic"
  }
}
```

### Response Fields

- **message** (string): Human-readable explanation of the activation status and next steps
- **context_id** (string): Context identifier for session persistence
- **task_id** (string): Unique identifier for tracking the activation
- **status** (string): Current status (pending, processing, deployed, failed)
- **decisioning_platform_segment_id** (string): The platform-specific ID to use once activated
- **estimated_activation_duration_minutes** (number, optional): Estimated time to complete
- **deployed_at** (string, optional): Timestamp when activation completed
- **error** (object, optional): Error details if activation failed

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