---
sidebar_position: 1
title: Core Concepts
description: Essential AdCP concepts that work across all protocols (MCP, A2A, REST). Understanding task states, status handling, and async operations.
keywords: [AdCP core concepts, task status, async operations, status handling, protocol agnostic]
---

# Core AdCP Concepts

Essential concepts for building AdCP clients, regardless of which protocol you're using (MCP, A2A, or future protocols).

## Task Status System

Every AdCP response includes a `status` field that tells you exactly what state the operation is in and what action you should take next.

### Status Values

AdCP uses the same status values as the [A2A protocol's TaskState enum](https://a2a-protocol.org/dev/specification/#63-taskstate-enum):

| Status | Meaning | Your Action |
|--------|---------|-------------|
| `submitted` | Task received, waiting to start | Show "queued" indicator, wait for updates |
| `working` | Agent actively processing | Show progress, poll/stream for updates |
| `input-required` | Needs information from you | Read `message` field, prompt user, send follow-up |
| `completed` | Successfully finished | Process `data`, show success message |
| `canceled` | User/system canceled task | Show cancellation notice, clean up |
| `failed` | Error occurred | Show error from `message`, handle gracefully |
| `rejected` | Agent rejected the request | Show rejection reason, don't retry |
| `auth-required` | Authentication needed | Prompt for auth, retry with credentials |
| `unknown` | Indeterminate state | Log for debugging, may need manual intervention |

### Response Structure

Every AdCP response has this structure:

```json
{
  "status": "completed",           // Always present: what state we're in
  "message": "Found 5 products",  // Always present: human explanation
  "context_id": "ctx-123",         // Session continuity
  "data": {...}                    // Task-specific structured data
}
```

## Client Decision Logic

### Basic Status Handling

```javascript
function handleAdcpResponse(response) {
  switch (response.status) {
    case 'completed':
      // Success - process the data
      showSuccess(response.message);
      return processData(response.data);
      
    case 'input-required':
      // Need more info - prompt user
      const userInput = await promptUser(response.message);
      return sendFollowUp(response.context_id, userInput);
      
    case 'working':
      // In progress - show progress and wait
      showProgress(response.message);
      return pollForUpdates(response.context_id);
      
    case 'failed':
      // Error - show message and handle gracefully
      showError(response.message);
      return handleError(response.data?.errors);
      
    case 'auth-required':
      // Authentication needed
      const credentials = await getAuth();
      return retryWithAuth(credentials);
      
    default:
      // Unexpected status
      console.warn('Unknown status:', response.status);
      showMessage(response.message);
  }
}
```

### Advanced Status Patterns

#### 1. Clarification Flow
When status is `input-required`, the message tells you what's needed:

```json
{
  "status": "input-required",
  "message": "I need more information about your campaign. What's your budget and target audience?",
  "context_id": "ctx-123",
  "data": {
    "products": [],  // Empty until clarification provided
    "suggestions": ["budget", "audience", "timing"]
  }
}
```

**Client handling:**
```javascript
if (response.status === 'input-required') {
  // Extract what's needed from the message
  const missingInfo = extractRequirements(response.message);
  
  // Prompt user with specific questions
  const answers = await promptForInfo(missingInfo);
  
  // Send follow-up with same context_id
  return sendMessage(response.context_id, answers);
}
```

#### 2. Approval Flow
Human approval is a special case of `input-required`:

```json
{
  "status": "input-required", 
  "message": "Media buy exceeds auto-approval limit ($100K). Please approve to proceed with campaign creation.",
  "context_id": "ctx-123",
  "data": {
    "approval_required": true,
    "amount": 150000,
    "reason": "exceeds_limit"
  }
}
```

**Client handling:**
```javascript
if (response.status === 'input-required' && response.data?.approval_required) {
  // Show approval UI
  const approved = await showApprovalDialog(response.message, response.data);
  
  // Send approval decision
  const decision = approved ? "Approved" : "Rejected";
  return sendMessage(response.context_id, decision);
}
```

#### 3. Long-Running Operations
Async operations start with `working` and provide updates:

```json
{
  "status": "working",
  "message": "Creating media buy. Validating inventory availability...",
  "context_id": "ctx-123", 
  "data": {
    "task_id": "task-456",
    "progress": 25,
    "step": "inventory_validation"
  }
}
```

**Protocol-specific polling:**
- **MCP**: Poll with context_id for updates
- **A2A**: Subscribe to SSE stream for real-time updates

## Async Operations

### Operation Types

AdCP operations fall into three categories:

1. **Synchronous** - Return immediately with `completed` or `failed`
   - `get_products`, `list_creative_formats`
   - Fast operations that don't require external systems

2. **Interactive** - May return `input-required` before proceeding
   - `get_products` (when brief is vague)
   - Operations that need clarification or approval

3. **Asynchronous** - Return `working` and require polling/streaming
   - `create_media_buy`, `activate_signal`, `sync_creatives`
   - Operations that integrate with external systems

### Timeout Handling

Set reasonable timeouts based on operation type:

```javascript
const TIMEOUTS = {
  sync: 30_000,        // 30 seconds for immediate operations
  interactive: 300_000, // 5 minutes for human input
  async: 1_800_000     // 30 minutes for long-running tasks
};

function setTimeoutForStatus(status) {
  switch (status) {
    case 'working': return TIMEOUTS.async;
    case 'input-required': return TIMEOUTS.interactive;
    default: return TIMEOUTS.sync;
  }
}
```

## Context Management

### Session Continuity

The `context_id` maintains conversation state across requests:

```javascript
class AdcpSession {
  constructor() {
    this.contextId = null;
  }
  
  async send(request) {
    // Include context from previous responses
    if (this.contextId) {
      request.context_id = this.contextId;
    }
    
    const response = await this.client.send(request);
    
    // Save context for next request
    this.contextId = response.context_id;
    
    return response;
  }
}
```

### Context Expiration

Contexts typically expire after 1 hour of inactivity:

```javascript
function isContextExpired(error) {
  return error.code === 'context_expired' || 
         error.message?.includes('context not found');
}

async function handleRequest(request) {
  try {
    return await session.send(request);
  } catch (error) {
    if (isContextExpired(error)) {
      // Start new conversation
      session.reset();
      return session.send(request);
    }
    throw error;
  }
}
```

## Error Handling

### Error Categories

1. **Protocol Errors** - Transport/connection issues
   - Handle with retries and fallback
   - Not related to AdCP business logic

2. **Task Errors** - Business logic failures
   - Returned as `status: "failed"` with error details
   - Should be displayed to user

3. **Validation Errors** - Malformed requests
   - Fix request format and retry
   - Usually development-time issues

### Error Response Format

Failed operations return status `failed` with details:

```json
{
  "status": "failed",
  "message": "Unable to create media buy: Insufficient inventory available for your targeting criteria",
  "context_id": "ctx-123",
  "data": {
    "error_code": "insufficient_inventory",
    "requested_impressions": 10000000,
    "available_impressions": 2500000,
    "suggestions": [
      "Expand geographic targeting",
      "Increase CPM bid",
      "Adjust date range"
    ]
  }
}
```

## Human-in-the-Loop Workflows

### Design Principles

1. **Optional by default** - Approvals are configured per implementation
2. **Clear messaging** - Users understand what they're approving
3. **Timeout gracefully** - Don't block forever on human input
4. **Audit trail** - Track who approved what when

### Approval Patterns

```javascript
async function handleApprovalWorkflow(response) {
  if (response.status === 'input-required' && needsApproval(response)) {
    // Show approval UI with context
    const approval = await showApprovalUI({
      title: "Campaign Approval Required",
      message: response.message,
      details: response.data,
      approver: getCurrentUser()
    });
    
    // Send approval decision
    const decision = {
      approved: approval.approved,
      notes: approval.notes,
      approver_id: approval.approver_id,
      timestamp: new Date().toISOString()
    };
    
    return sendFollowUp(response.context_id, decision);
  }
}
```

## Protocol-Agnostic Examples

### Product Discovery with Clarification

```javascript
// Works with both MCP and A2A
async function discoverProducts(brief) {
  let response = await adcp.send({
    task: 'get_products',
    brief: brief
  });
  
  // Handle clarification loop
  while (response.status === 'input-required') {
    const moreInfo = await promptUser(response.message);
    response = await adcp.send({
      context_id: response.context_id,
      additional_info: moreInfo
    });
  }
  
  if (response.status === 'completed') {
    return response.data.products;
  } else if (response.status === 'failed') {
    throw new Error(response.message);
  }
}
```

### Campaign Creation with Approval

```javascript
async function createCampaign(packages, budget) {
  let response = await adcp.send({
    task: 'create_media_buy',
    packages: packages,
    total_budget: budget
  });
  
  // Handle approval if needed
  if (response.status === 'input-required') {
    const approved = await getApproval(response.message);
    if (!approved) {
      throw new Error('Campaign creation not approved');
    }
    
    response = await adcp.send({
      context_id: response.context_id,
      approved: true
    });
  }
  
  // Handle async creation
  if (response.status === 'working') {
    response = await waitForCompletion(response);
  }
  
  if (response.status === 'completed') {
    return response.data.media_buy_id;
  } else {
    throw new Error(response.message);
  }
}
```

## Migration Guide

### From Custom Status Fields

If you're using custom status handling:

**Before:**
```json
{
  "clarification_needed": true,
  "approval_required": true, 
  "processing": false
}
```

**After:**
```json
{
  "status": "input-required",
  "message": "Budget exceeds limit. Please approve to proceed."
}
```

### Backwards Compatibility

During the transition period, responses may include both old and new fields:

```javascript
function getStatus(response) {
  // New unified approach
  if (response.status) {
    return response.status;
  }
  
  // Backwards compatibility
  if (response.clarification_needed) return 'input-required';
  if (response.approval_required) return 'input-required'; 
  if (response.processing) return 'working';
  
  return 'completed'; // Default assumption
}
```

## Next Steps

- **MCP Integration**: See [MCP Guide](./mcp-guide.md) for tool calls and context management
- **A2A Integration**: See [A2A Guide](./a2a-guide.md) for artifacts and streaming
- **Protocol Comparison**: See [Protocol Comparison](./protocol-comparison.md) for choosing between MCP and A2A

This unified status approach ensures consistent behavior across all AdCP implementations while making client development more predictable and robust.