# Creative Workflow with A2A Context Management

This example shows how A2A's `contextId` perfectly handles the iterative nature of creative workflows in advertising.

## The Workflow

A typical creative workflow involves multiple steps:
1. Initial creative upload
2. Automated review and feedback
3. Request for variations (different sizes, formats)
4. Approval cycles
5. Final asset delivery

With A2A's context model, this becomes a natural conversation.

## Complete Example: Adding Creatives to a Campaign

### Step 1: Initial Creative Upload

```json
// Client sends creative
{
  "method": "message/send",
  "params": {
    "message": {
      "role": "user",
      "parts": [
        {
          "kind": "text",
          "text": "Upload creative for the pet food campaign media buy mb_12345"
        },
        {
          "kind": "file",
          "uri": "https://cdn.agency.com/creatives/petfood_hero_30s.mp4",
          "metadata": {
            "filename": "petfood_hero_30s.mp4",
            "mimeType": "video/mp4",
            "duration": 30,
            "dimensions": { "width": 1920, "height": 1080 }
          }
        }
      ]
    }
  }
}
```

### Step 2: Agent Response with Context

```json
// Agent creates task and establishes context
{
  "taskId": "task-creative-001",
  "contextId": "ctx-creative-petfood-mb12345",  // Context for this creative workflow
  "status": {
    "state": "working"
  },
  "message": "Analyzing creative and checking policy compliance..."
}

// Status updates via SSE
data: {"message": "✓ Duration check passed (30s)"}
data: {"message": "✓ Resolution check passed (1920x1080)"}
data: {"message": "✓ Audio levels within range"}
data: {"message": "⚠️ Missing captions for accessibility"}

// Final response
{
  "taskId": "task-creative-001",
  "contextId": "ctx-creative-petfood-mb12345",
  "status": {
    "state": "completed"
  },
  "artifacts": [{
    "artifactId": "art-creative-v1",
    "name": "creative_analysis",
    "parts": [{
      "kind": "application/json",
      "data": {
        "creativeId": "creative_petfood_30s_v1",
        "status": "approved_with_suggestions",
        "analysis": {
          "technical": "pass",
          "policy": "pass",
          "accessibility": "warning"
        },
        "suggestions": [
          {
            "type": "accessibility",
            "priority": "high",
            "description": "Add captions for hearing-impaired viewers",
            "impact": "Required for some platforms"
          },
          {
            "type": "optimization",
            "priority": "medium",
            "description": "Create 15s version for better inventory match",
            "impact": "Could access 40% more inventory"
          },
          {
            "type": "format",
            "priority": "medium", 
            "description": "Create vertical (9:16) version for mobile",
            "impact": "Mobile inventory has 35% better performance"
          }
        ]
      }
    }]
  }]
}
```

### Step 3: Client Requests Variations (Same Context)

```json
// Client continues in same context
{
  "method": "message/send",
  "params": {
    "contextId": "ctx-creative-petfood-mb12345",  // Same context!
    "referenceTaskIds": ["task-creative-001"],     // Reference previous task
    "message": {
      "role": "user",
      "parts": [{
        "kind": "text",
        "text": "Please create the 15s version and add captions to both versions"
      }]
    }
  }
}
```

### Step 4: Agent Processes Request with Context

```json
// Agent has full context and can reference previous artifacts
{
  "taskId": "task-creative-002",
  "contextId": "ctx-creative-petfood-mb12345",  // Maintains context
  "status": {
    "state": "working"
  },
  "message": "Creating variations based on your request..."
}

// Progress updates
data: {"message": "Generating 15-second cut..."}
data: {"message": "Identifying key moments for shorter version..."}
data: {"message": "Adding captions to 30s version..."}
data: {"message": "Adding captions to 15s version..."}
data: {"message": "Validating all versions..."}

// Completion with new artifacts
{
  "taskId": "task-creative-002",
  "contextId": "ctx-creative-petfood-mb12345",
  "status": {
    "state": "completed"
  },
  "artifacts": [{
    "artifactId": "art-creative-v2",
    "name": "creative_package",
    "parts": [
      {
        "kind": "file",
        "uri": "https://cdn.publisher.com/processed/petfood_hero_30s_captioned.mp4",
        "metadata": {
          "creativeId": "creative_petfood_30s_v2",
          "version": 2,
          "duration": 30,
          "hasCaptions": true,
          "format": "video_standard_30s"
        }
      },
      {
        "kind": "file", 
        "uri": "https://cdn.publisher.com/processed/petfood_hero_15s_captioned.mp4",
        "metadata": {
          "creativeId": "creative_petfood_15s_v1",
          "version": 1,
          "duration": 15,
          "hasCaptions": true,
          "format": "video_standard_15s"
        }
      }
    ]
  }],
  "message": "Created 2 versions with captions. Both are ready for the campaign."
}
```

### Step 5: Human Review Required (Same Context)

```json
// Something requires human review
{
  "taskId": "task-creative-003",
  "contextId": "ctx-creative-petfood-mb12345",
  "status": {
    "state": "pending_review",
    "metadata": {
      "reviewType": "brand_safety",
      "flaggedElement": "Background music similarity",
      "reviewer": "legal@publisher.com"
    }
  },
  "message": "Creative requires legal review due to potential music copyright concern",
  "artifacts": [{
    "name": "review_package",
    "parts": [{
      "kind": "application/json",
      "data": {
        "concern": "Background music has 87% similarity to copyrighted track",
        "track": "Popular Song by Famous Artist",
        "timestamp": "0:12-0:28",
        "recommendation": "Replace audio track or obtain license"
      }
    }]
  }]
}
```

### Step 6: Approval/Resolution (Same Context)

```json
// Legal team responds in the same context
{
  "method": "message/send", 
  "params": {
    "contextId": "ctx-creative-petfood-mb12345",
    "message": {
      "role": "user",
      "parts": [{
        "kind": "text",
        "text": "Approved - we have licensing rights for this track. Document attached.",
      }, {
        "kind": "file",
        "uri": "https://legal.publisher.com/licenses/track_license_2024.pdf"
      }]
    }
  }
}

// Agent continues with approval
{
  "taskId": "task-creative-004",
  "contextId": "ctx-creative-petfood-mb12345",
  "status": {
    "state": "completed"
  },
  "message": "All creatives approved and assigned to media buy mb_12345",
  "artifacts": [{
    "name": "final_creative_assignment",
    "parts": [{
      "kind": "application/json",
      "data": {
        "mediaBuyId": "mb_12345",
        "creatives": [
          {
            "creativeId": "creative_petfood_30s_v2",
            "packageAssignments": ["pkg_ctv_premium"],
            "status": "active"
          },
          {
            "creativeId": "creative_petfood_15s_v1", 
            "packageAssignments": ["pkg_ctv_standard", "pkg_mobile_video"],
            "status": "active"
          }
        ],
        "legalClearance": {
          "status": "approved",
          "documentId": "doc_license_456",
          "approvedBy": "legal@publisher.com"
        }
      }
    }]
  }]
}
```

## Why This Is Powerful

### 1. **Natural Conversation Flow**
The entire creative workflow happens in one context, like a conversation thread. No need to pass state between disconnected API calls.

### 2. **Automatic State Management**
The agent maintains the context - it knows which media buy, which creatives, what's been discussed.

### 3. **Multi-Party Collaboration**
Different users (creative team, legal, account manager) can all participate in the same context.

### 4. **Audit Trail**
The complete conversation history is maintained, perfect for compliance and debugging.

### 5. **Flexible Workflow**
Can handle unexpected paths (like legal review) without breaking the flow.

## Comparison with MCP

With MCP, this same workflow would require:

```javascript
// Multiple disconnected API calls
const creative1 = await mcp.call('upload_creative', {...});
const analysis = await mcp.call('analyze_creative', {creative_id: creative1.id});
const variations = await mcp.call('create_variations', {
  creative_id: creative1.id,
  variations: ['15s', 'add_captions']
});

// If human review needed, must implement custom task system
if (analysis.requires_review) {
  const taskId = await mcp.call('create_review_task', {...});
  // Poll or webhook for completion
  // Lose conversational context
}

// Must manually thread IDs through each call
const assignment = await mcp.call('assign_creatives', {
  media_buy_id: 'mb_12345',
  creative_ids: [creative1.id, ...variations.ids]
});
```

With A2A, it's just a natural conversation in one context.