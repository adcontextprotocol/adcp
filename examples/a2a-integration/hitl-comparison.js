/**
 * Comparison: Human-in-the-Loop Implementation
 * 
 * Shows how A2A's native Task model simplifies HITL compared to 
 * implementing it on top of MCP
 */

// ============================================
// CURRENT: MCP-based HITL (Complex)
// ============================================

class MCPBasedHITL {
  constructor() {
    // Need to build our own task management
    this.tasks = new Map();
    this.webhooks = new Map();
  }

  async createMediaBuy(params) {
    try {
      // Try to create
      const result = await this.adServer.createCampaign(params);
      return result;
    } catch (error) {
      if (error.code === 'APPROVAL_REQUIRED') {
        // Need to create our own task system
        const taskId = this.generateTaskId();
        
        // Store task state
        this.tasks.set(taskId, {
          id: taskId,
          type: 'media_buy_approval',
          status: 'pending',
          params: params,
          created: new Date()
        });

        // Send webhook notification
        await this.notifyApprover(taskId);

        // Return error with task ID
        return {
          error: {
            code: 'PENDING_APPROVAL',
            message: 'Manual approval required',
            task_id: taskId,
            // Client must poll or register webhook
            poll_url: `/tasks/${taskId}/status`
          }
        };
      }
      throw error;
    }
  }

  // Need separate endpoints for task management
  async getTaskStatus(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error('Task not found');
    return task;
  }

  async approveTask(taskId, approver) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error('Task not found');
    
    // Update task
    task.status = 'approved';
    task.approvedBy = approver;
    
    // Execute the original operation
    const result = await this.adServer.createCampaign(task.params);
    
    // Notify webhook if registered
    const webhook = this.webhooks.get(taskId);
    if (webhook) {
      await fetch(webhook.url, {
        method: 'POST',
        body: JSON.stringify({ taskId, status: 'completed', result })
      });
    }
    
    return result;
  }
}

// ============================================
// NEW: A2A-based HITL (Native)
// ============================================

class A2ABasedHITL {
  async handleMediaBuyTask(message, task) {
    const params = this.parseParams(message);
    
    // Update task status as we progress
    await task.update({
      status: { state: 'working' },
      message: 'Validating campaign parameters...'
    });

    // Check if approval needed
    const validation = await this.validateCampaign(params);
    
    if (validation.requiresApproval) {
      // A2A handles this natively
      await task.update({
        status: { 
          state: 'pending_approval',
          metadata: {
            approvalType: 'compliance',
            reason: validation.reason,
            approver: 'compliance@agency.com'
          }
        },
        message: `Campaign requires ${validation.approvalType} approval`,
        // Client can subscribe to updates
        pushNotificationConfig: {
          url: message.configuration?.pushNotificationConfig?.url
        }
      });

      // Task is now in pending state
      // A2A protocol handles:
      // - State persistence
      // - Status queries
      // - Update notifications
      // - Context preservation
      
      // When approved (via separate A2A message or webhook)
      // the task continues in the same context
      return;
    }

    // If no approval needed, continue
    await task.update({
      message: 'Creating campaign in ad server...'
    });

    const result = await this.adServer.createCampaign(params);

    // Return completed task with artifacts
    return {
      status: { state: 'completed' },
      artifacts: [{
        name: 'media_buy_confirmation',
        parts: [{
          kind: 'application/json',
          data: result
        }]
      }]
    };
  }

  // Approval is just another A2A message in the same context
  async handleApprovalMessage(message, task) {
    const { contextId, referenceTaskIds } = message;
    
    // Find the pending task in this context
    const pendingTask = await this.findPendingTask(contextId, referenceTaskIds);
    
    if (message.parts[0].text.includes('approved')) {
      // Continue the original task
      await pendingTask.update({
        status: { state: 'working' },
        message: 'Approval received, creating campaign...'
      });
      
      // Execute the campaign
      const result = await this.adServer.createCampaign(pendingTask.params);
      
      // Complete with result
      await pendingTask.update({
        status: { state: 'completed' },
        artifacts: [{
          name: 'media_buy_confirmation',
          parts: [{
            kind: 'application/json',
            data: result
          }]
        }]
      });
    } else {
      // Rejection
      await pendingTask.update({
        status: { 
          state: 'failed',
          error: {
            code: 'APPROVAL_REJECTED',
            message: 'Campaign rejected by approver'
          }
        }
      });
    }
  }
}

// ============================================
// USAGE COMPARISON
// ============================================

// MCP: Complex polling/webhook pattern
const mcpClient = {
  async createCampaignWithApproval() {
    // 1. Try to create
    const response = await mcp.call('create_media_buy', params);
    
    if (response.error?.code === 'PENDING_APPROVAL') {
      // 2. Register webhook or start polling
      const taskId = response.error.task_id;
      
      // Option A: Polling
      while (true) {
        const status = await fetch(`/tasks/${taskId}/status`);
        if (status.status !== 'pending') break;
        await sleep(5000);
      }
      
      // Option B: Webhook
      await fetch('/webhooks/register', {
        method: 'POST',
        body: JSON.stringify({
          task_id: taskId,
          url: 'https://myapp.com/webhooks/task-updates'
        })
      });
    }
  }
};

// A2A: Native task handling
const a2aClient = {
  async createCampaignWithApproval() {
    // 1. Send message (with optional notification URL)
    const response = await a2a.send({
      message: {
        parts: [{
          kind: 'text',
          text: 'Create $100K CTV campaign for pet food'
        }]
      },
      configuration: {
        pushNotificationConfig: {
          url: 'https://myapp.com/a2a/notifications'
        }
      }
    });

    // 2. A2A handles everything
    // - Returns task with status
    // - Streams updates via SSE if connected
    // - Sends webhook notifications if configured
    // - Maintains context for follow-ups
    
    // 3. Can check status anytime
    const status = await a2a.getTask(response.taskId);
    
    // 4. Can continue in same context
    if (status.state === 'pending_approval') {
      // Approver can respond in same context
      await a2a.send({
        contextId: response.contextId,
        message: {
          parts: [{ kind: 'text', text: 'Approved' }]
        }
      });
    }
  }
};

// ============================================
// REAL EXAMPLE: Creative Review Workflow
// ============================================

class CreativeReviewWorkflow {
  async handleCreativeSubmission(message, task) {
    const { contextId } = task;
    
    // Extract creative from message
    const creative = message.parts.find(p => p.kind === 'file');
    
    await task.update({
      status: { state: 'working' },
      message: 'Analyzing creative for policy compliance...'
    });

    // Run automated checks
    const autoReview = await this.runAutomatedChecks(creative);
    
    await task.update({
      message: `Automated checks: ${autoReview.passed ? 'Passed' : 'Failed'}`,
      artifacts: [{
        name: 'automated_review',
        parts: [{
          kind: 'application/json',
          data: autoReview
        }]
      }]
    });

    if (!autoReview.passed || autoReview.requiresHumanReview) {
      // Need human review
      await task.update({
        status: { 
          state: 'pending_review',
          metadata: {
            reviewType: 'creative_policy',
            autoReviewResult: autoReview,
            assignedTo: 'creative-review@publisher.com'
          }
        },
        message: 'Creative requires human review',
        // Include preview for reviewer
        artifacts: [{
          name: 'review_package',
          parts: [
            { kind: 'file', uri: creative.uri },
            { kind: 'application/json', data: autoReview }
          ]
        }]
      });
      
      // Task pauses here naturally
      // Reviewer can respond in same context with approval/rejection
      return;
    }

    // Auto-approved
    await this.approveCreative(creative, task);
  }

  async handleReviewerResponse(message, task) {
    const { contextId, referenceTaskIds } = message;
    const decision = this.parseDecision(message);
    
    if (decision.approved) {
      await task.update({
        status: { state: 'working' },
        message: 'Creative approved, generating variations...'
      });
      
      // Generate required formats
      const variations = await this.generateVariations(task.originalCreative);
      
      await task.update({
        status: { state: 'completed' },
        message: 'Creative approved and variations generated',
        artifacts: [{
          name: 'approved_creatives',
          parts: variations.map(v => ({
            kind: 'file',
            uri: v.uri,
            metadata: { format: v.format }
          }))
        }]
      });
    } else {
      await task.update({
        status: { state: 'rejected' },
        message: `Creative rejected: ${decision.reason}`,
        metadata: {
          rejectionReason: decision.reason,
          suggestedChanges: decision.suggestions
        }
      });
    }
  }
}

/**
 * Key Advantages of A2A for HITL:
 * 
 * 1. **Native Status Model**: pending_approval, pending_review are first-class states
 * 2. **Context Preservation**: Approvals happen in the same conversation context
 * 3. **No Polling Required**: SSE provides real-time updates
 * 4. **Simpler Implementation**: No need to build task management infrastructure
 * 5. **Better UX**: Natural conversation flow for multi-step processes
 * 6. **Audit Trail**: Task history maintained automatically
 */