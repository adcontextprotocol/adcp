---
title: Agent Implementation Guide
---

# Signals Implementation Guide for Coding Agents

This guide provides step-by-step instructions for coding agents implementing the AdCP Signals specification. You can implement AdCP Signals using either **MCP** (Model Context Protocol) or **A2A** (Agent2Agent) protocol - both are first-class, fully-supported options.

## Choose Your Protocol

### Option 1: MCP (Model Context Protocol)
**Best for:**
- Simple signal queries and activation
- Synchronous signal retrieval
- Integration with existing MCP systems

### Option 2: A2A (Agent2Agent)
**Best for:**
- Real-time signal streaming
- Complex signal workflows
- Native async signal processing
- Built-in approval for sensitive signals

## Quick Start Checklist

```markdown
## Implementation Progress
- [ ] Choose protocol: MCP or A2A
- [ ] Understand signal types and data flow
- [ ] Set up signal ingestion pipeline
- [ ] Implement get_signals task
- [ ] Implement activate_signal task  
- [ ] Build signal processing engine
- [ ] Add privacy compliance (consent, hashing)
- [ ] Implement signal aggregation
- [ ] Add real-time delivery optimization
- [ ] Test signal accuracy and latency
- [ ] Monitor signal health metrics
```

## Prerequisites

Before implementing, ensure you have:
1. Completed the [Media Buy Implementation](../media-buy/agent-implementation-guide.md)
2. Read the [Signals Overview](./overview.md)
3. Reviewed the [Signals Specification](./specification.md)
4. Choose your protocol and understand it:
   - [MCP Protocol Guide](../protocols/mcp.md) - for MCP implementations
   - [A2A Protocol Guide](../protocols/a2a.md) - for A2A implementations
   - [Protocol Overview](../protocols/overview.md) - comparison guide
5. Understood the async patterns from [Orchestrator Design](../media-buy/orchestrator-design.md)

## Key Lessons from Implementation Experience

### 🔐 Critical Patterns for Signals

Based on our reference implementation experience:

1. **Privacy-First Design**
   - NEVER store raw PII - always hash before storage/transmission
   - Use SHA256 for email/phone hashing
   - Validate consent before any signal processing
   - Design for compliance from the start, not as an afterthought

2. **Real-Time Processing at Scale**
   - Signals can arrive at 10,000+ per second
   - Use queuing and batching for efficient processing
   - Implement rate limiting and backpressure
   - Cache aggressively but with short TTLs (5 minutes)

3. **Message Field Pattern (Consistent with Media Buy)**
   - All responses include human-readable `message` field first
   - Include `context_id` for state persistence
   - This enables AI agents to understand without parsing

4. **Multi-Identity Support**
   - Support multiple identity types (RampID, UID2, MAIDs)
   - Handle identity resolution asynchronously
   - Don't require all identity types - be flexible

5. **Natural Language Signal Discovery**
   - AI agents describe signals in natural language
   - System finds or creates matching signals
   - This is more powerful than fixed catalogs

## Core Concepts

### What Are Signals?

Signals are real-time data streams that optimize media delivery:
- **Audience Signals**: First-party data about users
- **Context Signals**: Environmental and situational data
- **Performance Signals**: Campaign effectiveness metrics
- **Intent Signals**: User behavior and interests

### Signal Flow Architecture

```typescript
// Signal flow: Principal → Orchestrator → Publisher
interface SignalFlow {
  // 1. Principal generates signals
  principal: {
    audience_data: AudienceSignal[],
    intent_data: IntentSignal[],
    context_data: ContextSignal[]
  },
  
  // 2. Orchestrator processes and routes
  orchestrator: {
    validate: (signal: Signal) => boolean,
    transform: (signal: Signal) => ProcessedSignal,
    route: (signal: ProcessedSignal) => Publisher[]
  },
  
  // 3. Publisher uses for optimization
  publisher: {
    match: (signal: ProcessedSignal) => TargetableInventory,
    optimize: (signals: ProcessedSignal[]) => DeliveryPlan
  }
}
```

## Implementation Guide

### Phase 1: Signal Infrastructure

#### 1. Define Signal Data Models

```typescript
// Base signal structure
interface Signal {
  id: string;
  type: "audience" | "context" | "performance" | "intent";
  source: string;
  timestamp: string; // ISO 8601
  data: SignalData;
  privacy: PrivacySettings;
}

// Audience signal with privacy-safe identifiers
interface AudienceSignal extends Signal {
  type: "audience";
  data: {
    hashed_email?: string; // SHA256
    hashed_phone?: string; // SHA256
    segment_ids?: string[];
    attributes?: Record<string, any>;
  };
  consent: {
    purposes: string[];
    timestamp: string;
  };
}

// Context signal for environmental data
interface ContextSignal extends Signal {
  type: "context";
  data: {
    location?: GeoLocation;
    device?: DeviceInfo;
    time_of_day?: string;
    weather?: WeatherConditions;
  };
}

// Performance signal for optimization
interface PerformanceSignal extends Signal {
  type: "performance";
  data: {
    media_buy_id: string;
    metric: string;
    value: number;
    dimension?: string;
  };
}
```

#### 2. Set Up Server Foundation

<details>
<summary><b>MCP Server Setup</b></summary>

```typescript
// MCP: Tool-based signal handling
import { Server } from "@modelcontextprotocol/sdk/server/index.js";

const server = new Server({
  name: "adcp-signals-server",
  version: "1.0.0"
});

// Register signal tasks as tools
server.addTool({
  name: "get_signals",
  description: "Retrieve signals for optimization",
  handler: handleGetSignals
});

server.addTool({
  name: "activate_signal",
  description: "Activate signals for campaign",
  handler: handleActivateSignal
});
```
</details>

<details>
<summary><b>A2A Server Setup</b></summary>

```typescript
// A2A: Native streaming for signals
import { A2AServer } from "@google/agent2agent";

const server = new A2AServer({
  name: "AdCP Signals Agent",
  version: "1.0.0",
  capabilities: {
    adcp_compliant: true,
    signal_streaming: true,
    real_time_optimization: true
  }
});

// Enable SSE for signal streaming
server.enableSSE();

// Register signal stream endpoint
server.on('signalStream', async (context, params) => {
  const stream = createSignalStream(params);
  
  // Stream signals in real-time
  stream.on('signal', async (signal) => {
    await context.sendSignal(signal);
  });
});
```
</details>

#### 3. Set Up Signal Ingestion Pipeline

```typescript
class SignalIngestionPipeline {
  private queue: SignalQueue;
  private validator: SignalValidator;
  private storage: SignalStorage;
  
  async ingest(signal: Signal): Promise<void> {
    // 1. Validate signal format and consent
    if (!this.validator.isValid(signal)) {
      throw new ValidationError("Invalid signal format");
    }
    
    // 2. Check privacy compliance
    if (!this.checkPrivacyCompliance(signal)) {
      throw new PrivacyError("Signal lacks required consent");
    }
    
    // 3. Queue for processing
    await this.queue.push(signal);
    
    // 4. Process asynchronously
    this.processInBackground(signal);
  }
  
  private async processInBackground(signal: Signal): Promise<void> {
    try {
      // Transform and enrich
      const processed = await this.transform(signal);
      
      // Store for retrieval
      await this.storage.store(processed);
      
      // Trigger real-time optimization if applicable
      await this.triggerOptimization(processed);
    } catch (error) {
      await this.handleProcessingError(signal, error);
    }
  }
}
```

### Phase 2: Core Tasks Implementation

#### 4. Implement `get_signals`

**Purpose**: Retrieve available signals for a media buy

<details>
<summary><b>MCP Implementation</b></summary>

```typescript
// MCP: Direct tool call with response
async function handleGetSignals(params: GetSignalsParams): Promise<SignalResponse> {
  // Validate access permissions
  const hasAccess = await checkSignalAccess(
    params.principal_id,
    params.media_buy_id
  );
  
  if (!hasAccess) {
    throw new AuthorizationError("Access denied to signals");
  }
  
  // 2. Fetch relevant signals
  const signals = await fetchSignals({
    media_buy_id: params.media_buy_id,
    types: params.signal_types || ["audience", "context", "performance"],
    date_range: params.date_range || getLast30Days(),
    limit: params.limit || 1000
  });
  
  // 3. Aggregate and summarize
  const aggregated = aggregateSignals(signals);
  
  // 4. Calculate insights
  const insights = generateSignalInsights(aggregated);
  
  // Always include message field first!
  return {
    message: `Found ${signals.length} signals for media buy. Top performing: ${insights.top_signal}`,
    context_id: params.context_id || generateContextId(),
    signals: aggregated,
    insights,
    total_count: signals.length,
    date_range: params.date_range,
    last_updated: new Date().toISOString()
  };
}
```
</details>

<details>
<summary><b>A2A Implementation</b></summary>

```typescript
// A2A: Streaming signal delivery
async function handleGetSignals(context: Context, message: Message) {
  const taskId = generateTaskId();
  const params = extractSignalParams(message);
  
  // Send immediate acknowledgment
  await context.sendStatus({
    taskId,
    state: "working",
    message: "Retrieving signals..."
  });
  
  // Validate access
  const hasAccess = await checkSignalAccess(
    context.principal_id,
    params.media_buy_id
  );
  
  if (!hasAccess) {
    return { 
      status: { state: "failed" },
      message: "Access denied to signals"
    };
  }
  
  // Stream signals progressively
  const signals = await fetchSignals(params);
  let count = 0;
  
  for (const batch of chunkSignals(signals, 100)) {
    await context.sendStatus({
      taskId,
      state: "working",
      message: `Processing ${count += batch.length} signals...`,
      partial_data: batch
    });
  }
  
  // Final aggregation
  const aggregated = aggregateSignals(signals);
  const insights = generateSignalInsights(aggregated);
  
  return {
    status: { state: "completed" },
    message: `Found ${signals.length} signals. Top performing: ${insights.top_signal}`,
    contextId: context.id,
    artifacts: [{
      name: "signals",
      parts: [{
        kind: "application/json",
        data: { signals: aggregated, insights }
      }]
    }]
  };
}
```
</details>

#### 5. Implement `activate_signal`

**Purpose**: Enable specific signals for optimization

<details>
<summary><b>MCP Implementation</b></summary>

```typescript
// MCP: Activate with optional async processing
async function handleActivateSignal(params: ActivateSignalParams): Promise<ActivationResponse> {
  // Support natural language signal requests
  let signal;
  if (isNaturalLanguageRequest(params.signal_id)) {
    // Create custom signal from description
    signal = await createCustomSignal(params.signal_id);
  } else {
    // Use existing signal
    signal = await getSignal(params.signal_id);
  }
  
  if (!signal) {
    throw new NotFoundError("Signal not found");
  }
  
  // 2. Check activation requirements
  const requirements = checkActivationRequirements(signal);
  
  if (!requirements.met) {
    return {
      status: "failed",
      reason: requirements.missing_requirements,
      signal_id: params.signal_id
    };
  }
  
  // 3. Configure activation settings
  const activation = {
    signal_id: params.signal_id,
    media_buy_id: params.media_buy_id,
    activation_type: params.activation_type || "optimization",
    settings: {
      weight: params.weight || 1.0,
      priority: params.priority || "normal",
      expiration: params.expiration || null
    },
    created_at: new Date().toISOString()
  };
  
  // 4. Activate the signal
  await activateSignal(activation);
  
  // 5. Trigger immediate optimization if requested
  if (params.immediate_optimization) {
    await triggerOptimization(params.media_buy_id, activation);
  }
  
  return {
    message: `Signal activated successfully. Expected lift: ${activation.expected_lift}x`,
    context_id: params.context_id || generateContextId(),
    status: "active",
    signal_id: params.signal_id,
    activation_id: activation.id,
    activated_at: activation.created_at
  };
}
```
</details>

<details>
<summary><b>A2A Implementation</b></summary>

```typescript
// A2A: Activate with real-time feedback
async function handleActivateSignal(context: Context, message: Message) {
  const taskId = generateTaskId();
  const params = extractActivationParams(message);
  
  // Stream activation progress
  await context.sendStatus({
    taskId,
    state: "working",
    message: "Validating signal..."
  });
  
  // Support natural language
  let signal;
  if (isNaturalLanguageRequest(params.signal_id)) {
    await context.sendStatus({
      taskId,
      state: "working",
      message: "Creating custom signal from your description..."
    });
    signal = await createCustomSignal(params.signal_id);
  } else {
    signal = await getSignal(params.signal_id);
  }
  
  // Check if approval needed for sensitive signals
  if (signal.requires_approval) {
    await context.sendStatus({
      taskId,
      state: "pending_approval",
      metadata: {
        reason: "Sensitive data activation requires approval",
        signal_type: signal.type
      }
    });
    
    const approval = await context.waitForApproval();
    if (!approval.approved) {
      return {
        status: { state: "failed" },
        message: `Activation rejected: ${approval.reason}`
      };
    }
  }
  
  // Activate the signal
  await context.sendStatus({
    taskId,
    state: "working",
    message: "Activating signal across platforms..."
  });
  
  const activation = await activateSignal(signal, params);
  
  // Start real-time optimization
  if (params.immediate_optimization) {
    startSignalOptimization(activation, context);
  }
  
  return {
    status: { state: "completed" },
    message: `Signal activated. Expected lift: ${activation.expected_lift}x`,
    contextId: context.id,
    artifacts: [{
      name: "activation_confirmation",
      parts: [{
        kind: "application/json",
        data: {
          activation_id: activation.id,
          signal_id: signal.id,
          status: "active"
        }
      }]
    }]
  };
}
```
</details>
```

### Phase 3: Signal Processing Engine

#### 5. Build Real-Time Processing

```typescript
class SignalProcessor {
  private matchers: Map<string, SignalMatcher>;
  private optimizers: Map<string, Optimizer>;
  
  async processSignal(signal: ProcessedSignal): Promise<OptimizationAction[]> {
    const actions: OptimizationAction[] = [];
    
    // 1. Match signal to active media buys
    const matches = await this.findMatchingMediaBuys(signal);
    
    for (const mediaBuy of matches) {
      // 2. Check if optimization is needed
      const shouldOptimize = await this.shouldOptimize(mediaBuy, signal);
      
      if (shouldOptimize) {
        // 3. Generate optimization actions
        const optimizer = this.optimizers.get(mediaBuy.optimization_strategy);
        const action = await optimizer.optimize(mediaBuy, signal);
        
        actions.push(action);
      }
    }
    
    // 4. Execute actions
    await this.executeActions(actions);
    
    return actions;
  }
  
  private async findMatchingMediaBuys(signal: ProcessedSignal): Promise<MediaBuy[]> {
    // Use efficient matching algorithm
    const candidates = await this.getCandidateMediaBuys(signal.type);
    
    return candidates.filter(mb => {
      const matcher = this.matchers.get(mb.matching_strategy);
      return matcher.matches(mb, signal);
    });
  }
}
```

#### 6. Implement Privacy-Safe Matching

**CRITICAL LESSON**: Privacy compliance is not optional. Design for it from day one.

```typescript
class PrivacyCompliantMatcher {
  // LESSON: Never store raw PII - this is non-negotiable!
  private readonly hashAlgorithm = "sha256";
  
  async matchAudience(signal: AudienceSignal, targetCriteria: TargetingCriteria): Promise<boolean> {
    // 1. Check consent
    if (!this.hasRequiredConsent(signal, targetCriteria)) {
      return false;
    }
    
    // 2. Match using hashed identifiers only
    if (signal.data.hashed_email && targetCriteria.hashed_emails) {
      const match = await this.matchHashedEmails(
        signal.data.hashed_email,
        targetCriteria.hashed_emails
      );
      if (match) return true;
    }
    
    // 3. Match segments (no PII)
    if (signal.data.segment_ids && targetCriteria.segments) {
      const match = this.matchSegments(
        signal.data.segment_ids,
        targetCriteria.segments
      );
      if (match) return true;
    }
    
    return false;
  }
  
  private hasRequiredConsent(signal: AudienceSignal, criteria: TargetingCriteria): boolean {
    const requiredPurposes = criteria.required_consent_purposes || ["advertising"];
    return requiredPurposes.every(purpose => 
      signal.consent.purposes.includes(purpose)
    );
  }
  
  // LESSON: Normalize before hashing (lowercase, trim)
  // This ensures consistent hashing across systems
  hashPII(value: string): string {
    // Critical: normalize first!
    const normalized = value.toLowerCase().trim();
    return crypto
      .createHash(this.hashAlgorithm)
      .update(normalized)
      .digest("hex");
  }
}
```

### Phase 4: Optimization Engine

#### 7. Implement Signal-Based Optimization

```typescript
class SignalOptimizer {
  async optimizeDelivery(mediaBuy: MediaBuy, signals: ProcessedSignal[]): Promise<OptimizationPlan> {
    // 1. Analyze signal patterns
    const analysis = this.analyzeSignals(signals);
    
    // 2. Identify optimization opportunities
    const opportunities = this.findOpportunities(analysis, mediaBuy);
    
    // 3. Generate optimization plan
    const plan: OptimizationPlan = {
      media_buy_id: mediaBuy.id,
      adjustments: [],
      expected_impact: null
    };
    
    for (const opportunity of opportunities) {
      switch (opportunity.type) {
        case "budget_reallocation":
          plan.adjustments.push(
            this.generateBudgetAdjustment(opportunity, mediaBuy)
          );
          break;
          
        case "targeting_refinement":
          plan.adjustments.push(
            this.generateTargetingAdjustment(opportunity, signals)
          );
          break;
          
        case "creative_optimization":
          plan.adjustments.push(
            this.generateCreativeAdjustment(opportunity, analysis)
          );
          break;
          
        case "pacing_adjustment":
          plan.adjustments.push(
            this.generatePacingAdjustment(opportunity, mediaBuy)
          );
          break;
      }
    }
    
    // 4. Calculate expected impact
    plan.expected_impact = this.calculateExpectedImpact(plan.adjustments, mediaBuy);
    
    // 5. Apply adjustments if auto-optimize is enabled
    if (mediaBuy.auto_optimize) {
      await this.applyOptimizations(plan);
    }
    
    return plan;
  }
  
  private analyzeSignals(signals: ProcessedSignal[]): SignalAnalysis {
    return {
      audience_insights: this.extractAudienceInsights(signals),
      performance_trends: this.identifyPerformanceTrends(signals),
      context_patterns: this.findContextPatterns(signals),
      anomalies: this.detectAnomalies(signals)
    };
  }
}
```

#### 8. Implement Feedback Loop

```typescript
class SignalFeedbackLoop {
  async processFeedback(delivery: DeliveryData, signals: ProcessedSignal[]): Promise<void> {
    // 1. Correlate delivery with signals
    const correlation = this.correlateDeliveryWithSignals(delivery, signals);
    
    // 2. Generate performance signals
    const performanceSignals = this.generatePerformanceSignals(correlation);
    
    // 3. Update signal weights based on effectiveness
    await this.updateSignalWeights(correlation);
    
    // 4. Store learnings for future optimization
    await this.storeLearnings({
      media_buy_id: delivery.media_buy_id,
      timestamp: new Date().toISOString(),
      correlation,
      performance_signals: performanceSignals,
      insights: this.extractInsights(correlation)
    });
    
    // 5. Trigger re-optimization if needed
    if (this.shouldReoptimize(correlation)) {
      await this.triggerReoptimization(delivery.media_buy_id);
    }
  }
  
  private correlateDeliveryWithSignals(
    delivery: DeliveryData,
    signals: ProcessedSignal[]
  ): Correlation {
    // Statistical correlation between signals and performance
    return {
      signal_effectiveness: this.calculateSignalEffectiveness(delivery, signals),
      attribution: this.performAttribution(delivery, signals),
      confidence_score: this.calculateConfidence(delivery.sample_size)
    };
  }
}
```

## Testing Your Implementation

### 1. Signal Ingestion Tests

```typescript
describe("Signal Ingestion", () => {
  it("should accept valid audience signals", async () => {
    const signal: AudienceSignal = {
      id: "sig_123",
      type: "audience",
      source: "crm",
      timestamp: new Date().toISOString(),
      data: {
        hashed_email: sha256("user@example.com"),
        segment_ids: ["high_value", "repeat_customer"]
      },
      consent: {
        purposes: ["advertising", "analytics"],
        timestamp: new Date().toISOString()
      }
    };
    
    const result = await ingestSignal(signal);
    expect(result.status).toBe("accepted");
  });
  
  it("should reject signals without consent", async () => {
    const signal = createSignalWithoutConsent();
    
    await expect(ingestSignal(signal))
      .rejects.toThrow("Signal lacks required consent");
  });
});
```

### 2. Optimization Tests

```typescript
describe("Signal Optimization", () => {
  it("should optimize based on performance signals", async () => {
    // Setup: Create media buy and signals
    const mediaBuy = await createTestMediaBuy();
    const signals = generatePerformanceSignals(mediaBuy.id);
    
    // Execute optimization
    const plan = await optimizer.optimizeDelivery(mediaBuy, signals);
    
    // Verify optimization plan
    expect(plan.adjustments).toHaveLength(greaterThan(0));
    expect(plan.expected_impact.improvement).toBeGreaterThan(0);
  });
});
```

### 3. Privacy Compliance Tests

```typescript
describe("Privacy Compliance", () => {
  it("should hash PII before storage", async () => {
    const email = "user@example.com";
    const signal = createAudienceSignalWithEmail(email);
    
    await ingestSignal(signal);
    
    // Verify raw email is never stored
    const stored = await getStoredSignal(signal.id);
    expect(stored.data.email).toBeUndefined();
    expect(stored.data.hashed_email).toBe(sha256(email));
  });
});
```

## Protocol-Specific Considerations

### MCP Signal Handling
- **Polling for Updates**: Clients poll for signal processing status
- **Batch Retrieval**: Get signals in batches for efficiency
- **Context via Parameters**: Pass context_id to maintain state
- **Synchronous Activation**: Signal activation returns immediately or with task_id

### A2A Signal Handling  
- **Real-Time Streaming**: Use SSE for continuous signal updates
- **Progressive Loading**: Stream large signal sets progressively
- **Native Approvals**: Sensitive signals can require approval
- **Automatic Context**: Context persists across signal operations

### Signal-Specific Protocol Features

| Feature | MCP | A2A |
|---------|-----|-----|
| **Real-time signal streaming** | Custom implementation | Native SSE |
| **Batch signal processing** | Return all at once | Progressive streaming |
| **Signal approval workflows** | Custom HITL | Native states |
| **Multi-identity resolution** | Synchronous | Can be async |
| **Natural language discovery** | Both support | Both support |

## Common Implementation Mistakes

### ❌ Don't Do This:
```typescript
// Wrong: Storing raw PII
const signal = {
  data: {
    email: "user@example.com", // LAWSUIT WAITING TO HAPPEN!
    phone: "+1234567890"        // GDPR/CCPA VIOLATION!
  }
};

// Wrong: Not checking consent
function processSignal(signal) {
  // Processing without consent check - illegal!
  return matchAudience(signal);
}
```

### ✅ Do This Instead:
```typescript
// Correct: Hash and check consent
function processSignal(signal) {
  // Always check consent first
  if (!hasRequiredConsent(signal)) {
    return { error: "Missing consent" };
  }
  
  // Only work with hashed data
  const hashedSignal = {
    data: {
      hashed_email: sha256(normalizeEmail(signal.email)),
      hashed_phone: sha256(normalizePhone(signal.phone))
    },
    consent: signal.consent // Preserve consent proof
  };
  
  return matchAudience(hashedSignal);
}
```

### ❌ Don't Do This:
```typescript
// Wrong: Processing signals synchronously
function processSignal(signal: Signal) {
  const result = expensiveComputation(signal); // Blocks!
  return result;
}
```

### ✅ Do This Instead:
```typescript
// Correct: Process asynchronously
async function processSignal(signal: Signal) {
  // Queue for background processing
  await signalQueue.push(signal);
  
  // Return immediately
  return { status: "queued", signal_id: signal.id };
}
```

## Performance Considerations

### 1. Signal Volume Management

**LESSON LEARNED**: Real-world signal volumes can spike 100x during events. Design for peaks, not averages.

```typescript
class SignalRateLimiter {
  // LESSON: Start conservative, scale based on monitoring
  private readonly maxSignalsPerSecond = 10000;
  private readonly batchSize = 100;
  
  async processBatch(signals: Signal[]): Promise<void> {
    // Process in batches to avoid overload
    for (let i = 0; i < signals.length; i += this.batchSize) {
      const batch = signals.slice(i, i + this.batchSize);
      await this.processBatchAsync(batch);
      
      // Rate limiting
      await this.enforceRateLimit();
    }
  }
}
```

### 2. Caching Strategy

**LESSON LEARNED**: Short TTLs (5 minutes) balance performance with freshness. Longer TTLs cause stale signal problems.

```typescript
class SignalCache {
  private readonly cache = new LRUCache<string, ProcessedSignal>({
    max: 10000,
    ttl: 1000 * 60 * 5 // 5 minutes - don't go longer!
  
  async getSignal(id: string): Promise<ProcessedSignal | null> {
    // Check cache first
    const cached = this.cache.get(id);
    if (cached) return cached;
    
    // Fetch from storage
    const signal = await this.storage.get(id);
    if (signal) {
      this.cache.set(id, signal);
    }
    
    return signal;
  }
}
```

## Monitoring and Health Checks

```typescript
class SignalHealthMonitor {
  async checkHealth(): Promise<HealthStatus> {
    return {
      ingestion_rate: await this.getIngestionRate(),
      processing_latency: await this.getProcessingLatency(),
      error_rate: await this.getErrorRate(),
      signal_quality: await this.assessSignalQuality(),
      privacy_compliance: await this.checkPrivacyCompliance()
    };
  }
  
  async getMetrics(): Promise<SignalMetrics> {
    return {
      total_signals_processed: await this.getTotalProcessed(),
      signals_by_type: await this.getSignalsByType(),
      optimization_impact: await this.measureOptimizationImpact(),
      consent_rate: await this.getConsentRate()
    };
  }
}
```

## Validation Checklist

Before considering your implementation complete:

### Core Requirements (Both Protocols)
- [ ] All responses include `message` field as first field
- [ ] All signal types are supported (audience, context, performance, intent)
- [ ] Privacy compliance is enforced (consent checking, PII hashing)
- [ ] PII is ALWAYS hashed before storage/transmission
- [ ] Email/phone normalization happens before hashing
- [ ] Consent is validated before ANY signal processing
- [ ] Natural language signal discovery is supported
- [ ] Multi-identity support (RampID, UID2, MAIDs, etc.)
- [ ] Real-time processing pipeline is implemented
- [ ] Signal-based optimization is working
- [ ] Feedback loop updates signal effectiveness
- [ ] Rate limiting prevents overload (10K signals/sec baseline)
- [ ] Caching improves performance (5-minute TTL)
- [ ] Batching reduces processing overhead
- [ ] Monitoring tracks signal health
- [ ] All tests pass including privacy tests
- [ ] Documentation is complete

### MCP-Specific
- [ ] Context persistence via context_id parameter
- [ ] Batch signal retrieval implemented
- [ ] Polling endpoints for async signal processing
- [ ] Task status endpoints for long-running operations

### A2A-Specific  
- [ ] SSE endpoints for signal streaming
- [ ] Progressive signal loading for large datasets
- [ ] Context automatically maintained across operations
- [ ] Approval states for sensitive signal activation
- [ ] Artifacts used for structured signal data

## Getting Help

- Review the [Signals Overview](./overview.md) for conceptual understanding
- Check [Signals Specification](./specification.md) for detailed requirements
- See [Privacy & Security](../reference/security.md) for compliance guidelines
- Consult [Error Codes](../reference/error-codes.md) for signal-specific errors

## Next Steps

After implementing Signals:
1. Add advanced optimization strategies
2. Implement cross-channel signal correlation
3. Build predictive models using signal history
4. Create signal quality scoring system
5. Add real-time dashboards for signal monitoring