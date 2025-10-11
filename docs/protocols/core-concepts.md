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
| `submitted` | Task queued for execution | Show "queued" indicator, wait for updates |
| `working` | Agent actively processing | Show progress, poll frequently for updates |
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

3. **Asynchronous** - Return `working` or `submitted` and require polling/streaming
   - `create_media_buy`, `activate_signal`, `sync_creatives`
   - Operations that integrate with external systems or require human approval

### Timeout Handling

Set reasonable timeouts based on operation type:

```javascript
const TIMEOUTS = {
  sync: 30_000,        // 30 seconds for immediate operations
  interactive: 300_000, // 5 minutes for human input
  working: 120_000,    // 2 minutes for working tasks
  submitted: 86_400_000 // 24 hours for submitted tasks
};

function setTimeoutForStatus(status) {
  switch (status) {
    case 'working': return TIMEOUTS.working;
    case 'submitted': return TIMEOUTS.submitted;
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

## Task Management & Webhooks

### Task Tracking

All async operations return a `task_id` at the protocol level for tracking:

```json
{
  "status": "submitted",
  "task_id": "task_456", 
  "message": "Media buy requires manual approval",
  "context_id": "ctx-123"
}
```

### Protocol-Level Webhook Configuration

Webhook configuration is handled at the protocol wrapper level, not in individual task parameters:

#### MCP Webhook Pattern
```javascript
class McpAdcpSession {
  async call(tool, params, options = {}) {
    const request = {
      tool: tool,
      arguments: params
    };

    // Protocol-level extensions (like context_id)
    if (this.contextId) {
      request.context_id = this.contextId;
    }

    // Use A2A-compatible push_notification_config
    if (options.push_notification_config) {
      request.push_notification_config = options.push_notification_config;
    }

    return await this.mcp.call(request);
  }
}

// Usage (Bearer token)
const response = await session.call('create_media_buy',
  { /* task params */ },
  {
    push_notification_config: {
      url: "https://buyer.com/webhooks/adcp",
      authentication: {
        schemes: ["Bearer"],
        credentials: "secret_token_32_chars"
      }
    }
  }
);

// Usage (HMAC signature - recommended for production)
const response = await session.call('create_media_buy',
  { /* task params */ },
  {
    push_notification_config: {
      url: "https://buyer.com/webhooks/adcp",
      authentication: {
        schemes: ["HMAC-SHA256"],
        credentials: "shared_secret_32_chars"
      }
    }
  }
);
```

#### A2A Native Support
```javascript
// A2A has native webhook support via PushNotificationConfig
// AdCP uses the same structure - no mapping needed!
await a2a.send({
  message: {
    parts: [{
      kind: "data",
      data: {
        skill: "create_media_buy",
        parameters: { /* task params */ }
      }
    }]
  },
  push_notification_config: {
    url: "https://buyer.com/webhooks/adcp",
    authentication: {
      schemes: ["HMAC-SHA256"],  // or ["Bearer"]
      credentials: "shared_secret_32_chars"
    }
  }
});
```

### Server Decision on Webhook Usage

The server decides whether to use webhooks based on the initial response status:

- **`completed`, `failed`, `rejected`**: Synchronous response - webhook is NOT called (client already has complete response)
- **`working`**: Will respond synchronously within ~120 seconds - webhook is NOT called (just wait for the response)
- **`submitted`**: Long-running async operation - webhook WILL be called on ALL subsequent status changes
- **Client choice**: Webhook is optional - clients can always poll with `tasks/get`

**Webhook trigger rule:** Webhooks are ONLY used when the initial response status is `submitted`.

**When webhooks are called (for `submitted` operations):**
- Status changes to `input-required` → Webhook called (human needs to respond)
- Status changes to `completed` → Webhook called (final result)
- Status changes to `failed` → Webhook called (error details)
- Status changes to `canceled` → Webhook called (cancellation confirmation)

### Webhook POST Format

When an async operation changes status, the publisher POSTs the **complete task response object** to your webhook URL.

#### Webhook Scenarios

**Scenario 1: Synchronous completion (no webhook)**
```javascript
// Initial request
const response = await session.call('create_media_buy', params, { webhook_url: "..." });

// Response is immediate and complete - webhook is NOT called
{
  "status": "completed",
  "media_buy_id": "mb_12345",
  "packages": [...]
}
```

**Scenario 2: Quick async processing (no webhook - use working status)**
```javascript
// Initial response indicates processing will complete soon
const response = await session.call('create_media_buy', params, { webhook_url: "..." });
{
  "status": "working",
  "task_id": "task_789",
  "message": "Creating media buy..."
}

// Wait for synchronous response (within ~120 seconds)
// Webhook is NOT called - client should wait for the response to complete
// The call will return the final result synchronously
```

**Scenario 3: Long-running operation (webhook IS called)**
```javascript
// Initial request
const response = await session.call('create_media_buy', params, {
  webhook_url: "https://buyer.com/webhooks/adcp/create_media_buy/agent_123/op_456"
});

// Response indicates long-running async operation
{
  "adcp_version": "1.6.0",
  "status": "submitted",
  "task_id": "task_456",
  "buyer_ref": "nike_q1_campaign_2024",
  "message": "Campaign requires sales approval. Expected time: 2-4 hours."
}

// Later: Webhook POST when approval is needed
POST /webhooks/adcp/create_media_buy/agent_123/op_456 HTTP/1.1
{
  "adcp_version": "1.6.0",
  "status": "input-required",
  "task_id": "task_456",
  "buyer_ref": "nike_q1_campaign_2024",
  "message": "Please approve $150K campaign to proceed"
}

// Later: Webhook POST when approved and completed (full create_media_buy response)
POST /webhooks/adcp/create_media_buy/agent_123/op_456 HTTP/1.1
{
  "adcp_version": "1.6.0",
  "status": "completed",
  "media_buy_id": "mb_12345",
  "buyer_ref": "nike_q1_campaign_2024",
  "creative_deadline": "2024-01-30T23:59:59Z",
  "packages": [
    {
      "package_id": "pkg_12345_001",
      "buyer_ref": "nike_ctv_sports_package"
    },
    {
      "package_id": "pkg_12345_002",
      "buyer_ref": "nike_audio_drive_package"
    }
  ]
}
```

#### For Other Async Operations

Each async operation posts its specific response schema:

- **`activate_signal`** → `activate-signal-response.json`
- **`sync_creatives`** → `sync-creatives-response.json`
- **`update_media_buy`** → `update-media-buy-response.json`

#### Webhook URL Patterns

Structure your webhook URLs to identify the operation and agent:

```
https://buyer.com/webhooks/adcp/{task_name}/{agent_id}/{operation_id}
```

**Example URLs:**
- `https://buyer.com/webhooks/adcp/create_media_buy/agent_abc/op_xyz`
- `https://buyer.com/webhooks/adcp/activate_signal/agent_abc/op_123`
- `https://buyer.com/webhooks/adcp/sync_creatives/agent_abc/op_456`

Your webhook handler can parse the URL path to route to the correct handler based on the task name.

#### Webhook Payload Structure

Every webhook POST contains the complete task response for that status, matching the task's response schema.

**`input-required` webhook (human needs to respond):**
```json
{
  "adcp_version": "1.6.0",
  "status": "input-required",
  "task_id": "task_456",
  "buyer_ref": "nike_q1_campaign_2024",
  "message": "Campaign budget requires VP approval to proceed"
}
```

**`completed` webhook (operation finished - full create_media_buy response):**
```json
{
  "adcp_version": "1.6.0",
  "status": "completed",
  "media_buy_id": "mb_12345",
  "buyer_ref": "nike_q1_campaign_2024",
  "creative_deadline": "2024-01-30T23:59:59Z",
  "packages": [
    {
      "package_id": "pkg_001",
      "buyer_ref": "nike_ctv_package"
    }
  ]
}
```

**`failed` webhook (operation failed):**
```json
{
  "adcp_version": "1.6.0",
  "status": "failed",
  "task_id": "task_456",
  "buyer_ref": "nike_q1_campaign_2024",
  "errors": [
    {
      "code": "insufficient_inventory",
      "message": "Requested targeting yielded 0 available impressions",
      "suggestion": "Broaden geographic targeting or increase budget"
    }
  ]
}
```

**Key principle:** Webhooks are ONLY called for `submitted` operations, and each webhook contains the full response object matching the task's response schema.

### Task State Reconciliation

Use `tasks/list` to recover from lost state:

```javascript
// Find all pending operations
const pending = await session.call('tasks/list', {
  filters: {
    statuses: ["submitted", "working", "input-required"]
  }
});

// Reconcile with local state
const missingTasks = pending.tasks.filter(task => 
  !localState.hasTask(task.task_id)
);

// Resume tracking missing tasks
for (const task of missingTasks) {
  startPolling(task.task_id);
}
```

### Status Progression

Tasks progress through predictable states:

```
submitted → working → completed
    ↓          ↓         ↑
input-required → → → → →
    ↓
  failed
```

- **`submitted`**: Task queued for execution, provide webhook or poll
- **`working`**: Agent actively processing, poll frequently  
- **`input-required`**: Need user input, continue conversation
- **`completed`**: Success, process results
- **`failed`**: Error, handle appropriately

For detailed timing expectations and polling patterns, see **[Task Management](./task-management.md#task-status-lifecycle)**.

## Webhook Reliability

### Delivery Semantics

AdCP webhooks use **at-least-once delivery** semantics with the following characteristics:

- **Not guaranteed**: Webhooks may fail due to network issues, server downtime, or configuration problems
- **May be duplicated**: The same event might be delivered multiple times
- **May arrive out of order**: Later events could arrive before earlier ones
- **Timeout behavior**: Webhook delivery has limited retry attempts and timeouts

### Security

#### Webhook Authentication (Required)

**AdCP adopts A2A's PushNotificationConfig structure** for webhook configuration. This provides a standard, flexible authentication model that supports multiple security schemes.

**Configuration Structure (A2A-Compatible):**
```json
{
  "push_notification_config": {
    "url": "https://buyer.example.com/webhooks/adcp",
    "authentication": {
      "schemes": ["Bearer"],
      "credentials": "secret_token_min_32_chars"
    }
  }
}
```

**Supported Authentication Schemes:**

1. **Bearer Token (Simple, Recommended for Development)**
   ```json
   {
     "authentication": {
       "schemes": ["Bearer"],
       "credentials": "secret_token_32_chars"
     }
   }
   ```

2. **HMAC Signature (Enterprise, Recommended for Production)**
   ```json
   {
     "authentication": {
       "schemes": ["HMAC-SHA256"],
       "credentials": "shared_secret_32_chars"
     }
   }
   ```

**Publisher Implementation (Bearer):**
```javascript
const config = pushNotificationConfig;
const scheme = config.authentication.schemes[0];

if (scheme === 'Bearer') {
  await axios.post(config.url, payload, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.authentication.credentials}`
    }
  });
}
```

**Publisher Implementation (HMAC-SHA256):**
```javascript
if (scheme === 'HMAC-SHA256') {
  const timestamp = new Date().toISOString();
  const signature = crypto
    .createHmac('sha256', config.authentication.credentials)
    .update(timestamp + JSON.stringify(payload))
    .digest('hex');

  await axios.post(config.url, payload, {
    headers: {
      'Content-Type': 'application/json',
      'X-ADCP-Signature': `sha256=${signature}`,
      'X-ADCP-Timestamp': timestamp
    }
  });
}
```

**Buyer Implementation (Bearer):**
```javascript
app.post('/webhooks/adcp', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }

  const token = authHeader.substring(7);
  if (token !== process.env.ADCP_WEBHOOK_TOKEN) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  await processWebhook(req.body);
  res.status(200).json({ status: 'processed' });
});
```

**Buyer Implementation (HMAC-SHA256):**
```javascript
app.post('/webhooks/adcp', async (req, res) => {
  const signature = req.headers['x-adcp-signature'];
  const timestamp = req.headers['x-adcp-timestamp'];

  if (!signature || !timestamp) {
    return res.status(401).json({ error: 'Missing signature headers' });
  }

  // Reject old webhooks (prevent replay attacks)
  const eventTime = new Date(timestamp);
  if (Date.now() - eventTime > 5 * 60 * 1000) {
    return res.status(401).json({ error: 'Webhook too old' });
  }

  // Verify signature
  const expectedSig = crypto
    .createHmac('sha256', process.env.ADCP_WEBHOOK_SECRET)
    .update(timestamp + JSON.stringify(req.body))
    .digest('hex');

  if (signature !== `sha256=${expectedSig}`) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  await processWebhook(req.body);
  res.status(200).json({ status: 'processed' });
});
```

**Authentication Best Practices:**
- **Bearer tokens**: Simple, good for development and testing
- **HMAC signatures**: Prevents replay attacks, recommended for production
- Credentials exchanged out-of-band (during publisher onboarding)
- Minimum 32 characters for all credentials
- Store securely (environment variables, secret management)
- Support credential rotation (accept old and new during transition)

### Retry and Circuit Breaker Patterns

Publishers MUST implement retry logic with circuit breakers to handle temporary buyer endpoint failures without overwhelming systems or accumulating unbounded queues.

#### Retry Strategy

Publishers SHOULD use exponential backoff with jitter for webhook delivery retries:

```javascript
class WebhookDelivery {
  constructor() {
    this.maxRetries = 3;
    this.baseDelay = 1000; // 1 second
    this.maxDelay = 60000; // 1 minute
  }

  async deliverWithRetry(url, payload, attempt = 0) {
    try {
      const response = await this.sendWebhook(url, payload);

      if (response.status >= 200 && response.status < 300) {
        return { success: true, attempts: attempt + 1 };
      }

      // Retry on 5xx errors and timeouts
      if (response.status >= 500 && attempt < this.maxRetries) {
        await this.delayWithJitter(attempt);
        return this.deliverWithRetry(url, payload, attempt + 1);
      }

      // Don't retry 4xx errors (client errors)
      return { success: false, error: 'Client error', attempts: attempt + 1 };

    } catch (error) {
      if (attempt < this.maxRetries) {
        await this.delayWithJitter(attempt);
        return this.deliverWithRetry(url, payload, attempt + 1);
      }
      return { success: false, error: error.message, attempts: attempt + 1 };
    }
  }

  async delayWithJitter(attempt) {
    const exponentialDelay = Math.min(
      this.baseDelay * Math.pow(2, attempt),
      this.maxDelay
    );
    // Add ±25% jitter to prevent thundering herd
    const jitter = exponentialDelay * (0.75 + Math.random() * 0.5);
    await new Promise(resolve => setTimeout(resolve, jitter));
  }

  async sendWebhook(url, payload) {
    return axios.post(url, payload, {
      timeout: 10000, // 10 second timeout
      headers: {
        'Content-Type': 'application/json',
        'X-ADCP-Signature': this.signPayload(payload),
        'X-ADCP-Timestamp': new Date().toISOString()
      }
    });
  }
}
```

**Retry Schedule:**
- Attempt 1: Immediate
- Attempt 2: After ~1 second (with jitter)
- Attempt 3: After ~2 seconds (with jitter)
- Attempt 4: After ~4 seconds (with jitter)
- Give up after 4 total attempts

#### Circuit Breaker Pattern

Publishers MUST implement circuit breakers to prevent webhook queues from growing unbounded when buyer endpoints are down:

```javascript
class CircuitBreaker {
  constructor(endpoint) {
    this.endpoint = endpoint;
    this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    this.failureCount = 0;
    this.failureThreshold = 5;
    this.successThreshold = 2;
    this.timeout = 60000; // 1 minute
    this.halfOpenTime = null;
    this.successCount = 0;
  }

  async execute(fn) {
    if (this.state === 'OPEN') {
      // Check if circuit should move to HALF_OPEN
      if (Date.now() - this.halfOpenTime > this.timeout) {
        this.state = 'HALF_OPEN';
        this.successCount = 0;
      } else {
        throw new Error('Circuit breaker is OPEN');
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  onSuccess() {
    this.failureCount = 0;

    if (this.state === 'HALF_OPEN') {
      this.successCount++;
      if (this.successCount >= this.successThreshold) {
        this.state = 'CLOSED';
        console.log(`Circuit breaker CLOSED for ${this.endpoint}`);
      }
    }
  }

  onFailure() {
    this.failureCount++;

    if (this.failureCount >= this.failureThreshold) {
      this.state = 'OPEN';
      this.halfOpenTime = Date.now();
      console.error(`Circuit breaker OPEN for ${this.endpoint}`);

      // Alert monitoring system
      this.alertMonitoring();
    }
  }

  alertMonitoring() {
    // Notify operations team that endpoint is down
    console.error(`ALERT: Webhook endpoint ${this.endpoint} is unreachable`);
    // Send to monitoring system (e.g., PagerDuty, Datadog)
  }

  isOpen() {
    return this.state === 'OPEN';
  }
}

// Usage with webhook delivery
class WebhookManager {
  constructor() {
    this.circuitBreakers = new Map();
    this.maxQueueSize = 1000; // Per endpoint
    this.queues = new Map();
  }

  getCircuitBreaker(endpoint) {
    if (!this.circuitBreakers.has(endpoint)) {
      this.circuitBreakers.set(endpoint, new CircuitBreaker(endpoint));
    }
    return this.circuitBreakers.get(endpoint);
  }

  async sendWebhook(endpoint, payload) {
    const breaker = this.getCircuitBreaker(endpoint);

    // Check circuit breaker before queuing
    if (breaker.isOpen()) {
      console.warn(`Dropping webhook for ${endpoint} - circuit breaker OPEN`);
      return { success: false, reason: 'circuit_breaker_open' };
    }

    // Check queue size limit
    const queue = this.queues.get(endpoint) || [];
    if (queue.length >= this.maxQueueSize) {
      console.error(`Dropping webhook for ${endpoint} - queue full (${queue.length})`);
      return { success: false, reason: 'queue_full' };
    }

    // Attempt delivery through circuit breaker
    try {
      return await breaker.execute(async () => {
        const delivery = new WebhookDelivery();
        return await delivery.deliverWithRetry(endpoint, payload);
      });
    } catch (error) {
      return { success: false, reason: error.message };
    }
  }
}
```

**Circuit Breaker States:**
- **CLOSED**: Normal operation, webhooks delivered
- **OPEN**: Endpoint is down, webhooks are dropped (not queued)
- **HALF_OPEN**: Testing if endpoint recovered, limited webhooks sent

**Why Circuit Breakers Matter:**
At Yahoo scale with thousands of campaigns, a single buyer endpoint being down could queue millions of webhooks. Circuit breakers prevent this by failing fast and dropping webhooks when endpoints are unreachable.

#### Queue Management

Publishers SHOULD implement bounded queues with overflow policies:

```javascript
class BoundedWebhookQueue {
  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
    this.queue = [];
    this.droppedCount = 0;
  }

  enqueue(webhook) {
    if (this.queue.length >= this.maxSize) {
      // Overflow policy: drop oldest webhooks
      const dropped = this.queue.shift();
      this.droppedCount++;
      console.warn(`Dropped webhook ${dropped.id} due to queue overflow`);
    }
    this.queue.push(webhook);
  }

  dequeue() {
    return this.queue.shift();
  }

  size() {
    return this.queue.length;
  }

  getDroppedCount() {
    return this.droppedCount;
  }
}
```

**Best Practices:**
- Set max queue size based on available memory and recovery time
- Monitor queue depth and dropped webhook counts
- Alert operations when queues are consistently full
- Use dead letter queues for manual investigation of persistent failures
- Implement queue per buyer endpoint (not global queue)

### Implementation Requirements

#### Idempotent Webhook Handlers

Always implement idempotent webhook handlers that can safely process the same event multiple times:

```javascript
app.post('/webhooks/adcp', async (req, res) => {
  const { task_id, current_status, timestamp, event_id } = req.body;
  
  // Idempotent check - avoid duplicate processing
  const existing = await db.getWebhookEvent(event_id);
  if (existing) {
    console.log(`Webhook ${event_id} already processed`);
    return res.status(200).json({ status: 'already_processed' });
  }
  
  // Record this webhook event
  await db.recordWebhookEvent(event_id, timestamp);
  
  // Process the status change
  await processTaskStatusChange(task_id, current_status, timestamp);
  
  // Always return 200 for successful processing
  res.status(200).json({ status: 'processed' });
});
```

#### Sequence Handling

Use timestamps to ensure proper event ordering:

```javascript
async function processTaskStatusChange(taskId, newStatus, timestamp) {
  const currentTask = await db.getTask(taskId);
  
  // Ignore out-of-order events
  if (currentTask?.updated_at >= timestamp) {
    console.log(`Ignoring out-of-order webhook for task ${taskId}`);
    return;
  }
  
  // Update task with new status
  await db.updateTask(taskId, {
    status: newStatus,
    updated_at: timestamp
  });
  
  // Trigger any business logic
  await handleStatusChange(taskId, newStatus);
}
```

#### Polling as Backup

Use polling as a reliable backup mechanism:

```javascript
class TaskTracker {
  constructor() {
    this.pendingTasks = new Map();
    this.pollInterval = 30000; // 30 seconds
  }
  
  async trackTask(taskId, webhookConfigured = false) {
    this.pendingTasks.set(taskId, {
      lastPolled: Date.now(),
      webhookConfigured,
      pollAttempts: 0
    });
    
    // Start polling backup even if webhook is configured
    this.schedulePolling(taskId);
  }
  
  async schedulePolling(taskId) {
    const task = this.pendingTasks.get(taskId);
    if (!task) return;
    
    // Increase polling interval if webhook is configured
    const interval = task.webhookConfigured ? 
      this.pollInterval * 4 : // 2 minutes with webhook
      this.pollInterval;      // 30 seconds without webhook
    
    setTimeout(async () => {
      if (this.pendingTasks.has(taskId)) {
        await this.pollTask(taskId);
        this.schedulePolling(taskId); // Continue polling
      }
    }, interval);
  }
  
  async pollTask(taskId) {
    try {
      const response = await adcp.call('tasks/get', {
        task_id: taskId,
        include_result: true
      });
      
      // Update our state
      await this.updateTaskState(taskId, response);
      
      // Stop tracking if complete
      if (['completed', 'failed', 'canceled'].includes(response.status)) {
        this.pendingTasks.delete(taskId);
      }
      
    } catch (error) {
      console.error(`Polling failed for task ${taskId}:`, error);
      
      // Exponential backoff on polling errors
      const task = this.pendingTasks.get(taskId);
      task.pollAttempts++;
      
      if (task.pollAttempts > 10) {
        console.error(`Giving up on task ${taskId} after 10 failed polls`);
        this.pendingTasks.delete(taskId);
      }
    }
  }
}
```

### Webhook Event Format

AdCP webhook events include all necessary information for processing:

```json
{
  "event_id": "evt_789abc123def",
  "event_type": "task_status_changed",
  "timestamp": "2025-01-22T10:25:00Z",
  "task_id": "task_456",
  "task_type": "create_media_buy",
  "domain": "media-buy",
  "previous_status": "working",
  "current_status": "completed",
  "context": {
    "buyer_ref": "nike_q1_2025",
    "media_buy_id": "mb_987654321"
  },
  "result": {
    // Included for completed tasks
    "media_buy_id": "mb_987654321",
    "packages": [...]
  },
  "error": {
    // Included for failed tasks
    "code": "insufficient_inventory",
    "message": "Requested targeting yielded 0 available impressions"
  }
}
```

### Security Considerations

#### Webhook Authentication

Verify webhook authenticity using the authentication method specified during webhook registration:

```javascript
function verifyWebhook(req, secret) {
  const signature = req.headers['x-adcp-signature'];
  const payload = JSON.stringify(req.body);
  const expectedSignature = createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  
  return signature === `sha256=${expectedSignature}`;
}

app.post('/webhooks/adcp', (req, res) => {
  if (!verifyWebhook(req, process.env.WEBHOOK_SECRET)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  
  // Process webhook...
});
```

#### Replay Attack Prevention

Use timestamps and event IDs to prevent replay attacks:

```javascript
function isReplayAttack(timestamp, eventId) {
  const eventTime = new Date(timestamp);
  const now = new Date();
  const fiveMinutes = 5 * 60 * 1000;
  
  // Reject events older than 5 minutes
  if (now - eventTime > fiveMinutes) {
    console.warn(`Rejecting old webhook event ${eventId}`);
    return true;
  }
  
  // Check if we've seen this event ID before
  return db.hasSeenWebhookEvent(eventId);
}
```

### Best Practices Summary

1. **Always implement polling backup** - Don't rely solely on webhooks
2. **Handle duplicates gracefully** - Use idempotent processing with event IDs
3. **Check timestamps** - Ignore out-of-order events based on timestamps
4. **Return 200 quickly** - Acknowledge webhook receipt immediately
5. **Verify authenticity** - Always validate webhook signatures
6. **Log webhook events** - Keep audit trail for debugging
7. **Set reasonable timeouts** - Don't wait forever for webhook delivery
8. **Graceful degradation** - Fall back to polling if webhooks consistently fail

This reliability pattern ensures your application remains responsive and consistent even when webhook delivery is unreliable or fails entirely.

### Reporting Webhooks

In addition to task status webhooks, AdCP supports **reporting webhooks** for automated delivery performance notifications. These webhooks are configured during media buy creation and follow a scheduled delivery pattern.

#### Configuration

Reporting webhooks are configured via the `reporting_webhook` parameter in `create_media_buy`:

```json
{
  "buyer_ref": "campaign_2024",
  "reporting_webhook": {
    "url": "https://buyer.example.com/webhooks/reporting",
    "auth_type": "bearer",
    "auth_token": "secret_token",
    "reporting_frequency": "daily"
  }
}
```

#### Publisher Commitment

When a reporting webhook is configured, publishers commit to sending:

**(campaign_duration / reporting_frequency) + 1** notifications

- One per frequency period during the campaign
- One final notification at campaign completion
- Delayed notifications if data isn't ready within expected delay window

#### Payload Structure

Reporting webhooks deliver the same payload as `get_media_buy_delivery` with additional metadata:

```json
{
  "notification_type": "scheduled",
  "sequence_number": 5,
  "next_expected_at": "2024-02-06T08:00:00Z",
  "reporting_period": {
    "start": "2024-02-05T00:00:00Z",
    "end": "2024-02-05T23:59:59Z"
  },
  "currency": "USD",
  "media_buy_deliveries": [
    {
      "media_buy_id": "mb_001",
      "buyer_ref": "campaign_a",
      "status": "active",
      "totals": {...},
      "by_package": [...]
    }
  ]
}
```

**Notification Types:**
- **`scheduled`**: Regular periodic update
- **`final`**: Campaign completed
- **`delayed`**: Data not yet available (prevents missed notification detection)

#### Webhook Aggregation

Publishers SHOULD aggregate webhooks when multiple media buys share the same webhook URL, reporting frequency, and reporting period. This reduces webhook volume significantly for buyers with many active campaigns.

**Example**: Buyer with 100 active campaigns receives:
- **Without aggregation**: 100 webhooks per reporting period
- **With aggregation**: 1 webhook containing all 100 campaigns in `media_buy_deliveries` array

Buyers must always handle `media_buy_deliveries` as an array, even when it contains a single media buy.

#### Timezone Handling

For daily and monthly frequencies, the publisher's reporting timezone (from product's `reporting_capabilities.timezone`) determines period boundaries:

- **Daily**: Midnight to midnight in publisher's timezone
- **Monthly**: 1st to last day of month in publisher's timezone
- **Hourly**: UTC unless specified

**Critical**: Store publisher's timezone when setting up webhooks to correctly interpret reporting periods.

#### Implementation Requirements

1. **Array Handling**: Always process `media_buy_deliveries` as an array (may contain 1 to N media buys)
2. **Idempotent Processing**: Same as task webhooks - handle duplicates safely
3. **Sequence Tracking**: Use `sequence_number` to detect gaps or out-of-order delivery
4. **Fallback Strategy**: Continue polling `get_media_buy_delivery` as backup
5. **Delay Handling**: Treat `"delayed"` notifications as normal, not errors
6. **Frequency Validation**: Ensure requested frequency is in product's `available_reporting_frequencies`
7. **Metrics Validation**: Ensure requested metrics are in product's `available_metrics`

See [Optimization & Reporting](../media-buy/media-buys/optimization-reporting.md#webhook-based-reporting) for complete implementation guidance.

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