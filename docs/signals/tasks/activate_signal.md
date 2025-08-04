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
  "context_id": "ctx-signals-abc123",  // Same context maintained
  "task_id": "activation_12345",
  "status": "pending",
  "decisioning_platform_segment_id": "pm_brand456_peer39_lux_auto",
  "estimated_activation_duration_minutes": 60
}
```

### Status Updates (streamed or polled)

```json
{
  "context_id": "ctx-signals-abc123",
  "task_id": "activation_12345",
  "status": "processing",
  "message": "Validating signal access permissions..."
}
```

### Final Response (when complete)

```json
{
  "context_id": "ctx-signals-abc123",
  "task_id": "activation_12345",
  "status": "deployed",
  "decisioning_platform_segment_id": "pm_brand456_peer39_lux_auto",
  "deployed_at": "2025-01-15T14:30:00Z",
  "message": "Signal successfully activated on PubMatic"
}
```

### Response Fields

- **context_id** (string): Context identifier for session persistence
- **task_id** (string): Unique identifier for tracking the activation
- **status** (string): Current status (pending, processing, deployed, failed)
- **decisioning_platform_segment_id** (string): The platform-specific ID to use once activated
- **estimated_activation_duration_minutes** (number, optional): Estimated time to complete
- **deployed_at** (string, optional): Timestamp when activation completed
- **message** (string, optional): Human-readable status message

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