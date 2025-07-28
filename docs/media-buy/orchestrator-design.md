---
title: Orchestrator Design Guide
---

# Orchestrator Design Guide

This guide provides best practices and requirements for implementing an AdCP:Buy orchestrator that properly handles asynchronous operations, pending states, and human-in-the-loop workflows.

## Core Design Principles

### 1. Asynchronous First

The AdCP:Buy protocol is inherently asynchronous. Operations may take seconds, hours, or even days to complete.

**DO:**
- Design all operations as async/await
- Store operation state persistently
- Handle orchestrator restarts gracefully
- Implement proper timeout handling

**DON'T:**
- Assume immediate completion
- Use synchronous blocking calls
- Store state only in memory
- Retry indefinitely without backoff

### 2. Pending States are Normal

Many operations return pending states that require eventual completion:

```python
PENDING_STATES = {
    "pending_manual",      # Awaiting human approval
    "pending_permission",  # Needs permission grant
    "pending_approval",    # Ad server review
    "pending_activation"   # Awaiting creatives
}

# These are NOT errors!
```

### 3. State Machine Design

Implement proper state machines for operations:

```python
class MediaBuyState(Enum):
    REQUESTED = "requested"
    PENDING_APPROVAL = "pending_approval"
    APPROVED = "approved"
    CREATING = "creating"
    CREATED = "created"
    ACTIVE = "active"
    FAILED = "failed"
    REJECTED = "rejected"
```

## Implementation Requirements

### 1. Operation Tracking

Store all operation requests with unique IDs:

```python
class OperationTracker:
    def __init__(self, db):
        self.db = db
    
    async def create_operation(self, operation_type, request_data):
        operation = {
            "id": str(uuid.uuid4()),
            "type": operation_type,
            "status": "requested",
            "request": request_data,
            "created_at": datetime.now(),
            "task_id": None,
            "result": None
        }
        await self.db.operations.insert_one(operation)
        return operation["id"]
    
    async def update_status(self, operation_id, status, **kwargs):
        update = {"status": status, "updated_at": datetime.now()}
        update.update(kwargs)
        await self.db.operations.update_one(
            {"id": operation_id},
            {"$set": update}
        )
```

### 2. Pending Operation Handler

Implement a handler for pending operations:

```python
class PendingOperationHandler:
    def __init__(self, mcp_client, tracker):
        self.mcp = mcp_client
        self.tracker = tracker
    
    async def handle_create_media_buy_response(self, operation_id, response):
        if response["status"] == "pending_manual":
            # Extract task ID from response
            task_id = self.extract_task_id(response["detail"])
            
            # Update operation with task ID
            await self.tracker.update_status(
                operation_id,
                "pending_approval",
                task_id=task_id
            )
            
            # Start monitoring task
            asyncio.create_task(
                self.monitor_task(operation_id, task_id)
            )
        
        elif response["status"] == "pending_activation":
            # Normal flow - awaiting creatives
            await self.tracker.update_status(
                operation_id,
                "created",
                media_buy_id=response["media_buy_id"]
            )
```

### 3. Task Monitoring

Implement efficient task monitoring with exponential backoff:

```python
class TaskMonitor:
    def __init__(self, mcp_client):
        self.mcp = mcp_client
        self.monitoring_tasks = {}
    
    async def monitor_task(self, operation_id, task_id):
        """Monitor a HITL task until completion."""
        backoff = 30  # Start with 30 seconds
        max_backoff = 300  # Max 5 minutes
        
        while True:
            try:
                # Get task status
                response = await self.mcp.call_tool(
                    "get_pending_tasks",
                    {"task_type": "manual_approval"}
                )
                
                task = self.find_task(response["tasks"], task_id)
                if not task:
                    # Task disappeared - likely completed
                    break
                
                if task["status"] == "completed":
                    await self.handle_task_completion(
                        operation_id, task
                    )
                    break
                elif task["status"] == "failed":
                    await self.handle_task_rejection(
                        operation_id, task
                    )
                    break
                
                # Exponential backoff
                await asyncio.sleep(backoff)
                backoff = min(backoff * 1.5, max_backoff)
                
            except Exception as e:
                logger.error(f"Error monitoring task {task_id}: {e}")
                await asyncio.sleep(backoff)
```

### 4. Webhook Support

Implement webhook endpoints for real-time updates:

```python
@app.post("/webhooks/hitl-tasks")
async def hitl_task_webhook(request: Request):
    """Handle HITL task status updates."""
    data = await request.json()
    
    if data["event"] == "task_completed":
        task_id = data["task_id"]
        
        # Find associated operation
        operation = await db.operations.find_one({
            "task_id": task_id
        })
        
        if operation:
            if data["resolution"] == "approved":
                # Task was approved - operation executed
                await handle_operation_completion(
                    operation["id"],
                    data["result"]
                )
            else:
                # Task was rejected
                await handle_operation_rejection(
                    operation["id"],
                    data["reason"]
                )
    
    return {"status": "received"}
```

### 5. User Communication

Keep users informed about pending operations:

```python
class UserNotifier:
    async def notify_pending_approval(self, user_id, operation):
        """Notify user that operation needs approval."""
        message = {
            "type": "pending_approval",
            "operation_id": operation["id"],
            "operation_type": operation["type"],
            "message": "Your media buy requires publisher approval",
            "estimated_time": "2-4 hours",
            "created_at": operation["created_at"]
        }
        await self.send_notification(user_id, message)
    
    async def notify_approval(self, user_id, operation):
        """Notify user of approval."""
        message = {
            "type": "operation_approved",
            "operation_id": operation["id"],
            "message": "Your media buy has been approved and created",
            "media_buy_id": operation["result"]["media_buy_id"]
        }
        await self.send_notification(user_id, message)
```

## Example Orchestrator Flow

```python
class AdCPOrchestrator:
    def __init__(self):
        self.mcp = MCPClient()
        self.tracker = OperationTracker(db)
        self.monitor = TaskMonitor(self.mcp)
        self.notifier = UserNotifier()
    
    async def create_media_buy(self, user_id, request):
        """Create a media buy with full async handling."""
        
        # 1. Create operation record
        operation_id = await self.tracker.create_operation(
            "create_media_buy",
            request
        )
        
        try:
            # 2. Call AdCP:Buy API
            response = await self.mcp.call_tool(
                "create_media_buy",
                request
            )
            
            # 3. Handle response based on status
            if response["status"] == "pending_manual":
                # Manual approval required
                task_id = extract_task_id(response["detail"])
                await self.tracker.update_status(
                    operation_id,
                    "pending_approval",
                    task_id=task_id
                )
                
                # Notify user
                await self.notifier.notify_pending_approval(
                    user_id,
                    await self.tracker.get_operation(operation_id)
                )
                
                # Start monitoring
                asyncio.create_task(
                    self.monitor.monitor_task(operation_id, task_id)
                )
                
                return {
                    "operation_id": operation_id,
                    "status": "pending_approval",
                    "message": "Media buy requires publisher approval"
                }
            
            elif response["status"] == "pending_activation":
                # Normal flow - created successfully
                await self.tracker.update_status(
                    operation_id,
                    "created",
                    media_buy_id=response["media_buy_id"]
                )
                
                return {
                    "operation_id": operation_id,
                    "status": "created",
                    "media_buy_id": response["media_buy_id"],
                    "creative_deadline": response["creative_deadline"]
                }
            
            else:
                # Failed
                await self.tracker.update_status(
                    operation_id,
                    "failed",
                    error=response.get("detail", "Unknown error")
                )
                
                return {
                    "operation_id": operation_id,
                    "status": "failed",
                    "error": response.get("detail")
                }
                
        except Exception as e:
            await self.tracker.update_status(
                operation_id,
                "failed",
                error=str(e)
            )
            raise
```

## Best Practices

### 1. Persistent Storage

Always use persistent storage for operation state:
- Database (MongoDB, PostgreSQL)
- Message queue (Redis, RabbitMQ)
- Distributed cache (Redis Cluster)

### 2. Idempotency

Make all operations idempotent:
```python
async def create_media_buy_idempotent(self, request):
    # Check if already exists
    existing = await self.db.operations.find_one({
        "type": "create_media_buy",
        "request.po_number": request["po_number"],
        "status": {"$in": ["created", "active"]}
    })
    
    if existing:
        return existing["result"]
    
    # Proceed with creation
    return await self.create_media_buy(request)
```

### 3. Timeout Handling

Implement reasonable timeouts:
```python
OPERATION_TIMEOUTS = {
    "create_media_buy": timedelta(hours=24),
    "update_media_buy": timedelta(hours=12),
    "creative_approval": timedelta(hours=48)
}
```

### 4. Error Recovery

Implement retry logic with circuit breakers:
```python
@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(min=1, max=60),
    retry=retry_if_exception_type(TransientError)
)
async def call_adcp_api(self, tool, params):
    try:
        return await self.mcp.call_tool(tool, params)
    except RateLimitError:
        # Back off gracefully
        raise TransientError("Rate limited")
    except NetworkError:
        # Retry network errors
        raise TransientError("Network error")
```

### 5. Monitoring and Alerting

Track key metrics:
- Pending operation count by type
- Average approval time
- Rejection rate
- Task timeout rate
- API error rate

## Testing Considerations

### 1. Simulate Pending States

Test handling of all pending states:
```python
@pytest.mark.asyncio
async def test_manual_approval_flow():
    orchestrator = AdCPOrchestrator()
    
    # Mock to return pending_manual
    with patch.object(orchestrator.mcp, 'call_tool') as mock:
        mock.return_value = {
            "status": "pending_manual",
            "detail": "Manual approval required. Task ID: task_123"
        }
        
        result = await orchestrator.create_media_buy(
            "user_1", 
            create_request
        )
        
        assert result["status"] == "pending_approval"
        
        # Verify task monitoring started
        assert "task_123" in orchestrator.monitor.monitoring_tasks
```

### 2. Test Timeout Scenarios

Ensure proper timeout handling:
```python
async def test_operation_timeout():
    # Create operation that will timeout
    operation_id = await tracker.create_operation(...)
    
    # Fast forward time
    with freeze_time() as frozen:
        frozen.move_to(datetime.now() + timedelta(hours=25))
        
        # Check timeout handler
        await timeout_handler.check_timeouts()
        
        # Verify marked as timed out
        op = await tracker.get_operation(operation_id)
        assert op["status"] == "timed_out"
```

## Conclusion

Building a robust AdCP:Buy orchestrator requires:
1. Asynchronous design throughout
2. Proper state management
3. Graceful handling of pending states
4. User communication
5. Monitoring and observability

Remember: Pending states are not errors - they're a normal part of the advertising workflow.