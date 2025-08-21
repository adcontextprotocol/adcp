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

### Comprehensive Test Strategy

**LESSON LEARNED**: Test not just functionality but also privacy compliance, performance at scale, and error recovery.

### 1. Signal Ingestion Tests

<details>
<summary><b>Core Ingestion Tests</b></summary>

```typescript
describe("Signal Ingestion Pipeline", () => {
  // Test valid signal processing
  it("should accept and process valid audience signals", async () => {
    const signal: AudienceSignal = {
      id: "sig_123",
      type: "audience",
      source: "crm",
      timestamp: new Date().toISOString(),
      data: {
        // CRITICAL: Always use hashed PII
        hashed_email: sha256("user@example.com".toLowerCase().trim()),
        hashed_phone: sha256("+14155551234"),
        segment_ids: ["high_value", "repeat_customer"],
        attributes: {
          ltv_tier: "premium",
          engagement_score: 0.85
        }
      },
      consent: {
        purposes: ["advertising", "analytics", "personalization"],
        timestamp: new Date().toISOString(),
        expiry: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
      }
    };
    
    const result = await ingestSignal(signal);
    
    expect(result.status).toBe("accepted");
    expect(result.signal_id).toBeDefined();
    expect(result.processing_time_ms).toBeLessThan(100);
  });
  
  // Test consent validation
  it("should reject signals without valid consent", async () => {
    const testCases = [
      { 
        name: "missing consent",
        signal: createSignalWithoutConsent() 
      },
      { 
        name: "expired consent",
        signal: createSignalWithExpiredConsent() 
      },
      { 
        name: "insufficient purposes",
        signal: createSignalWithInsufficientConsent() 
      }
    ];
    
    for (const testCase of testCases) {
      const result = await ingestSignal(testCase.signal);
      expect(result.status).toBe("rejected");
      expect(result.error.code).toBe("consent_invalid");
      expect(result.error.message).toContain(testCase.name);
    }
  });
  
  // Test PII handling
  it("should reject signals with unhashed PII", async () => {
    const signal = {
      ...validSignalBase,
      data: {
        email: "user@example.com", // RAW PII - should be rejected!
        phone: "415-555-1234"       // RAW PII - should be rejected!
      }
    };
    
    const result = await ingestSignal(signal);
    
    expect(result.status).toBe("rejected");
    expect(result.error.code).toBe("pii_not_hashed");
    expect(result.error.fields).toContain("email", "phone");
  });
  
  // Test identity resolution
  it("should resolve multiple identity types", async () => {
    const signal = {
      ...validSignalBase,
      identities: [
        { type: "hashed_email", value: sha256("user@example.com") },
        { type: "ramp_id", value: "XY123456789" },
        { type: "uid2", value: "AGx9..." },
        { type: "maid", value: "AEBE52E7-03EE-455A-B3C4-E57283966239" }
      ]
    };
    
    const result = await ingestSignal(signal);
    
    expect(result.status).toBe("accepted");
    expect(result.resolved_identities).toHaveLength(4);
    expect(result.match_rate).toBeGreaterThan(0.7);
  });
});
```
</details>

### 2. Signal Processing Performance Tests

<details>
<summary><b>Scale and Performance Tests</b></summary>

```typescript
describe("Signal Processing at Scale", () => {
  // Test batch processing efficiency
  it("should process large signal batches efficiently", async () => {
    const batchSizes = [100, 1000, 10000];
    const results = [];
    
    for (const size of batchSizes) {
      const signals = generateTestSignals(size);
      const startTime = Date.now();
      
      const result = await processBatchSignals(signals);
      
      const duration = Date.now() - startTime;
      const throughput = size / (duration / 1000); // signals per second
      
      results.push({
        size,
        duration,
        throughput,
        success_rate: result.successful / size
      });
      
      // Performance assertions
      expect(throughput).toBeGreaterThan(1000); // Min 1000 signals/sec
      expect(result.successful).toBeGreaterThan(size * 0.99); // 99% success rate
    }
    
    // Verify linear scaling
    const scalingFactor = results[2].duration / results[0].duration;
    expect(scalingFactor).toBeLessThan(120); // Should scale sub-linearly
  });
  
  // Test memory efficiency
  it("should not leak memory during sustained load", async () => {
    const initialMemory = process.memoryUsage().heapUsed;
    const iterations = 100;
    const batchSize = 1000;
    
    for (let i = 0; i < iterations; i++) {
      const signals = generateTestSignals(batchSize);
      await processBatchSignals(signals);
      
      // Force garbage collection if available
      if (global.gc) global.gc();
    }
    
    const finalMemory = process.memoryUsage().heapUsed;
    const memoryGrowth = (finalMemory - initialMemory) / initialMemory;
    
    expect(memoryGrowth).toBeLessThan(0.1); // Less than 10% growth
  });
  
  // Test concurrent processing
  it("should handle concurrent signal streams", async () => {
    const streams = 10;
    const signalsPerStream = 100;
    
    const streamPromises = Array(streams).fill(null).map(async (_, streamId) => {
      const signals = generateTestSignals(signalsPerStream, { streamId });
      return processStreamSignals(signals);
    });
    
    const results = await Promise.all(streamPromises);
    
    // All streams should complete successfully
    results.forEach(result => {
      expect(result.status).toBe("completed");
      expect(result.processed).toBe(signalsPerStream);
    });
    
    // Verify no signal mixing between streams
    const processedSignals = await getProcessedSignals();
    const streamGroups = groupBy(processedSignals, 'streamId');
    
    expect(Object.keys(streamGroups)).toHaveLength(streams);
  });
});
```
</details>

### 3. Optimization and Delivery Tests

<details>
<summary><b>Signal-Based Optimization Tests</b></summary>

```typescript
describe("Signal-Driven Optimization", () => {
  let mediaBuyId: string;
  let testSignals: Signal[];
  
  beforeEach(async () => {
    // Setup test campaign
    const mediaBuy = await createTestMediaBuy({
      budget: 100000,
      packages: [
        { product_id: "prod_1", budget: 50000 },
        { product_id: "prod_2", budget: 50000 }
      ]
    });
    mediaBuyId = mediaBuy.id;
    
    // Generate diverse test signals
    testSignals = [
      ...generateAudienceSignals(1000),
      ...generateContextSignals(500),
      ...generatePerformanceSignals(mediaBuyId, 200),
      ...generateIntentSignals(300)
    ];
  });
  
  it("should optimize delivery based on performance signals", async () => {
    // Ingest performance signals showing package 1 outperforming
    const perfSignals = [
      createPerformanceSignal(mediaBuyId, "package_1", { ctr: 0.05, cvr: 0.02 }),
      createPerformanceSignal(mediaBuyId, "package_2", { ctr: 0.02, cvr: 0.005 })
    ];
    
    await ingestSignals(perfSignals);
    
    // Request optimization
    const optimization = await optimizeDelivery(mediaBuyId);
    
    expect(optimization.recommendations).toContain(
      expect.objectContaining({
        action: "shift_budget",
        from_package: "package_2",
        to_package: "package_1",
        amount: expect.any(Number),
        reason: expect.stringContaining("performance")
      })
    );
  });
  
  it("should identify high-value audience segments", async () => {
    // Ingest audience signals with conversion data
    const audienceSignals = generateAudienceSignalsWithOutcomes({
      segment: "tech_professionals",
      conversion_rate: 0.08
    });
    
    await ingestSignals(audienceSignals);
    
    // Get segment recommendations
    const segments = await getHighValueSegments(mediaBuyId);
    
    expect(segments[0]).toMatchObject({
      segment_id: "tech_professionals",
      predicted_value: expect.any(Number),
      confidence: expect.any(Number),
      recommended_action: "increase_targeting"
    });
  });
  
  it("should adapt to real-time context changes", async () => {
    // Simulate weather context change
    const contextSignal = createContextSignal({
      type: "weather",
      data: { condition: "heavy_rain", severity: "high" },
      affected_regions: ["US-CA-SF", "US-CA-OAK"]
    });
    
    await ingestSignal(contextSignal);
    
    // Check delivery adjustments
    const adjustments = await getDeliveryAdjustments(mediaBuyId);
    
    expect(adjustments).toContain(
      expect.objectContaining({
        type: "creative_swap",
        reason: "weather_context",
        original_creative: expect.any(String),
        replacement_creative: expect.stringContaining("rain")
      })
    );
  });
});
```
</details>

### 4. Privacy and Compliance Tests

<details>
<summary><b>Privacy Compliance Test Suite</b></summary>

```typescript
describe("Privacy and Compliance", () => {
  // Test PII hashing
  it("should properly hash and normalize PII", async () => {
    const testCases = [
      { input: "John.Doe@EXAMPLE.com", expected: sha256("john.doe@example.com") },
      { input: " user@test.com ", expected: sha256("user@test.com") },
      { input: "+1 (415) 555-1234", expected: sha256("+14155551234") }
    ];
    
    for (const test of testCases) {
      const hashed = hashPII(test.input);
      expect(hashed).toBe(test.expected);
      
      // Verify original is not stored
      const stored = await getStoredValue(hashed);
      expect(stored).not.toContain(test.input);
    }
  });
  
  // Test consent enforcement
  it("should enforce consent for all signal operations", async () => {
    const signal = createSignalWithLimitedConsent(["analytics"]); // No advertising consent
    
    // Should accept for analytics
    const analyticsResult = await processForAnalytics(signal);
    expect(analyticsResult.status).toBe("success");
    
    // Should reject for advertising
    const adResult = await processForAdvertising(signal);
    expect(adResult.status).toBe("rejected");
    expect(adResult.error.code).toBe("insufficient_consent");
  });
  
  // Test data retention
  it("should respect data retention policies", async () => {
    const signal = createSignalWithRetention(7); // 7 day retention
    
    await ingestSignal(signal);
    
    // Verify signal exists
    let stored = await getSignal(signal.id);
    expect(stored).toBeDefined();
    
    // Fast-forward time
    await advanceTime(8 * 24 * 60 * 60 * 1000); // 8 days
    
    // Run retention cleanup
    await runRetentionCleanup();
    
    // Verify signal is deleted
    stored = await getSignal(signal.id);
    expect(stored).toBeNull();
  });
  
  // Test cross-border compliance
  it("should apply region-specific privacy rules", async () => {
    const regions = [
      { region: "EU", signal: createEUSignal(), expectedRules: ["GDPR"] },
      { region: "CA", signal: createCaliforniaSignal(), expectedRules: ["CCPA"] },
      { region: "UK", signal: createUKSignal(), expectedRules: ["UK-GDPR"] }
    ];
    
    for (const test of regions) {
      const result = await processSignalWithCompliance(test.signal);
      
      expect(result.applied_rules).toEqual(expect.arrayContaining(test.expectedRules));
      expect(result.compliance_checks).toMatchObject({
        consent_verified: true,
        lawful_basis: expect.any(String),
        data_minimization: true,
        purpose_limitation: true
      });
    }
  });
});
```
</details>

## Troubleshooting Common Issues

### Issue: Signals Not Matching Expected Audience

**Symptoms**: Low match rates, segments not activating, unexpected audience sizes.

**Root Causes**:
1. PII not normalized before hashing
2. Inconsistent hashing algorithms
3. Identity resolution failures

**Solutions**:
```typescript
class SignalMatcher {
  // CRITICAL: Consistent normalization
  private normalizeEmail(email: string): string {
    return email.toLowerCase().trim();
  }
  
  private normalizePhone(phone: string): string {
    // Remove all non-digits
    const digits = phone.replace(/\D/g, '');
    
    // Add country code if missing
    if (digits.length === 10) {
      return `+1${digits}`; // US assumption
    }
    
    return `+${digits}`;
  }
  
  // Use consistent hashing
  private hashValue(value: string): string {
    return crypto
      .createHash('sha256')
      .update(value, 'utf8')
      .digest('hex')
      .toLowerCase();
  }
  
  // Improve match rates with fuzzy matching
  async matchSignal(signal: Signal): Promise<MatchResult> {
    const matches = [];
    
    // Try exact match first
    let result = await this.exactMatch(signal);
    if (result) matches.push(result);
    
    // Try alternative identity types
    for (const identity of signal.identities || []) {
      result = await this.matchByIdentity(identity);
      if (result) matches.push(result);
    }
    
    // Try probabilistic matching if enabled
    if (this.config.enableProbabilistic) {
      result = await this.probabilisticMatch(signal);
      if (result && result.confidence > 0.8) {
        matches.push(result);
      }
    }
    
    return this.consolidateMatches(matches);
  }
}
```

### Issue: Signal Processing Latency

**Symptoms**: Slow signal activation, timeouts, queue backlog.

**Root Causes**:
1. Synchronous processing blocking the pipeline
2. Inefficient database queries
3. No caching layer

**Solutions**:
```typescript
class SignalProcessor {
  private cache = new LRUCache({ max: 10000, ttl: 300000 }); // 5 min TTL
  private queue = new PQueue({ concurrency: 10 });
  
  async processSignal(signal: Signal): Promise<ProcessedSignal> {
    // Check cache first
    const cacheKey = this.getCacheKey(signal);
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;
    
    // Queue for async processing
    return this.queue.add(async () => {
      const startTime = Date.now();
      
      try {
        // Process in parallel where possible
        const [validation, matching, enrichment] = await Promise.all([
          this.validateSignal(signal),
          this.matchSignal(signal),
          this.enrichSignal(signal)
        ]);
        
        const processed = {
          ...signal,
          validation,
          matching,
          enrichment,
          processing_time: Date.now() - startTime
        };
        
        // Cache result
        this.cache.set(cacheKey, processed);
        
        // Async persist (don't block)
        this.persistAsync(processed);
        
        return processed;
      } catch (error) {
        console.error(`Signal processing failed:`, error);
        throw error;
      }
    });
  }
  
  private async persistAsync(signal: ProcessedSignal): Promise<void> {
    // Fire and forget with error handling
    setImmediate(async () => {
      try {
        await this.db.saveSignal(signal);
      } catch (error) {
        console.error(`Failed to persist signal:`, error);
        // Add to retry queue
        this.retryQueue.add(signal);
      }
    });
  }
}
```

### Issue: Memory Growth in Signal Aggregation

**Symptoms**: Memory usage increases over time, OOM errors.

**Root Causes**:
1. Unbounded aggregation windows
2. Not releasing old signals
3. Memory leaks in event handlers

**Solutions**:
```typescript
class SignalAggregator {
  private windows = new Map<string, AggregationWindow>();
  private maxWindowSize = 10000;
  private windowTTL = 600000; // 10 minutes
  
  aggregate(signal: Signal): AggregateResult {
    const windowKey = this.getWindowKey(signal);
    let window = this.windows.get(windowKey);
    
    if (!window) {
      window = this.createWindow(windowKey);
    }
    
    // Add signal to window
    window.add(signal);
    
    // Enforce size limit
    if (window.size > this.maxWindowSize) {
      window.evictOldest();
    }
    
    // Clean up old windows periodically
    this.cleanupOldWindows();
    
    return window.getAggregates();
  }
  
  private cleanupOldWindows(): void {
    const now = Date.now();
    
    for (const [key, window] of this.windows.entries()) {
      if (now - window.lastAccessed > this.windowTTL) {
        window.cleanup(); // Release resources
        this.windows.delete(key);
      }
    }
  }
}
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

### Comprehensive Signal Monitoring

**LESSON LEARNED**: Monitor not just throughput but also signal quality, privacy compliance, and business impact.

```typescript
class SignalHealthMonitor {
  private metrics = new MetricsCollector();
  private alerts = new AlertManager();
  
  async checkHealth(): Promise<HealthStatus> {
    const checks = {
      ingestion: await this.checkIngestionHealth(),
      processing: await this.checkProcessingHealth(),
      privacy: await this.checkPrivacyCompliance(),
      quality: await this.checkSignalQuality(),
      infrastructure: await this.checkInfrastructure()
    };
    
    // Determine overall health
    const criticalFailures = Object.values(checks).filter(c => c.status === 'critical');
    const warnings = Object.values(checks).filter(c => c.status === 'warning');
    
    return {
      status: criticalFailures.length > 0 ? 'unhealthy' : 
              warnings.length > 2 ? 'degraded' : 'healthy',
      checks,
      timestamp: new Date().toISOString()
    };
  }
  
  private async checkIngestionHealth(): Promise<ComponentHealth> {
    const rate = await this.getIngestionRate();
    const backlog = await this.getQueueBacklog();
    const errorRate = await this.getIngestionErrorRate();
    
    // Define thresholds
    const status = 
      errorRate > 0.05 ? 'critical' :  // >5% errors
      errorRate > 0.01 ? 'warning' :   // >1% errors
      backlog > 100000 ? 'warning' :   // Large backlog
      'healthy';
    
    return {
      status,
      metrics: {
        ingestion_rate_per_sec: rate,
        queue_backlog: backlog,
        error_rate: errorRate
      },
      message: status === 'healthy' ? 
        `Processing ${rate} signals/sec` :
        `High error rate: ${(errorRate * 100).toFixed(2)}%`
    };
  }
  
  private async checkSignalQuality(): Promise<ComponentHealth> {
    const metrics = {
      match_rate: await this.getIdentityMatchRate(),
      consent_coverage: await this.getConsentCoverage(),
      data_freshness: await this.getDataFreshness(),
      signal_diversity: await this.getSignalDiversity()
    };
    
    // Quality score (0-100)
    const qualityScore = 
      (metrics.match_rate * 30) +           // 30% weight
      (metrics.consent_coverage * 30) +     // 30% weight
      (metrics.data_freshness * 20) +       // 20% weight
      (metrics.signal_diversity * 20);      // 20% weight
    
    return {
      status: qualityScore > 80 ? 'healthy' : 
              qualityScore > 60 ? 'warning' : 'critical',
      metrics: {
        ...metrics,
        quality_score: qualityScore
      },
      message: `Signal quality score: ${qualityScore.toFixed(1)}/100`
    };
  }
  
  async getDetailedMetrics(): Promise<SignalMetrics> {
    const now = Date.now();
    const hourAgo = now - 3600000;
    const dayAgo = now - 86400000;
    
    return {
      // Volume metrics
      volume: {
        total_processed: await this.getTotalProcessed(),
        last_hour: await this.getProcessedSince(hourAgo),
        last_24h: await this.getProcessedSince(dayAgo),
        by_type: await this.getSignalsByType(),
        by_source: await this.getSignalsBySource()
      },
      
      // Performance metrics
      performance: {
        avg_latency_ms: await this.getAverageLatency(),
        p50_latency_ms: await this.getPercentileLatency(50),
        p95_latency_ms: await this.getPercentileLatency(95),
        p99_latency_ms: await this.getPercentileLatency(99),
        throughput_per_sec: await this.getCurrentThroughput()
      },
      
      // Quality metrics
      quality: {
        match_rate: await this.getIdentityMatchRate(),
        enrichment_rate: await this.getEnrichmentRate(),
        validation_pass_rate: await this.getValidationPassRate(),
        duplicate_rate: await this.getDuplicateRate()
      },
      
      // Privacy metrics
      privacy: {
        consent_rate: await this.getConsentRate(),
        opt_out_rate: await this.getOptOutRate(),
        retention_compliance: await this.getRetentionCompliance(),
        regions_covered: await this.getRegionsWithConsent()
      },
      
      // Business impact
      impact: {
        campaigns_optimized: await this.getCampaignsOptimized(),
        optimization_lift: await this.getOptimizationLift(),
        revenue_impact: await this.getRevenueImpact(),
        audience_reach_expansion: await this.getReachExpansion()
      }
    };
  }
}

// Real-time monitoring dashboard
class SignalDashboard {
  private monitor = new SignalHealthMonitor();
  private updateInterval = 5000; // 5 seconds
  
  async start(): Promise<void> {
    setInterval(async () => {
      const metrics = await this.monitor.getDetailedMetrics();
      const health = await this.monitor.checkHealth();
      
      // Update dashboard
      this.updateDashboard(metrics, health);
      
      // Check for alerts
      this.checkAlerts(metrics, health);
    }, this.updateInterval);
  }
  
  private checkAlerts(metrics: SignalMetrics, health: HealthStatus): void {
    // High error rate alert
    if (metrics.quality.validation_pass_rate < 0.95) {
      this.sendAlert('HIGH_ERROR_RATE', {
        current_rate: 1 - metrics.quality.validation_pass_rate,
        threshold: 0.05,
        severity: 'high'
      });
    }
    
    // Performance degradation alert
    if (metrics.performance.p95_latency_ms > 1000) {
      this.sendAlert('PERFORMANCE_DEGRADATION', {
        p95_latency: metrics.performance.p95_latency_ms,
        threshold: 1000,
        severity: 'medium'
      });
    }
    
    // Privacy compliance alert
    if (metrics.privacy.consent_rate < 0.90) {
      this.sendAlert('LOW_CONSENT_RATE', {
        current_rate: metrics.privacy.consent_rate,
        threshold: 0.90,
        severity: 'high',
        action: 'Review consent collection process'
      });
    }
  }
}

// Distributed tracing for signal flow
class SignalTracer {
  trace(signal: Signal): TraceContext {
    const traceId = generateTraceId();
    const spanId = generateSpanId();
    
    return {
      traceId,
      spanId,
      startTime: Date.now(),
      
      // Track signal through pipeline
      recordSpan(name: string, operation: () => Promise<any>): Promise<any> {
        const span = {
          traceId,
          parentSpanId: spanId,
          spanId: generateSpanId(),
          name,
          startTime: Date.now()
        };
        
        return operation()
          .then(result => {
            span.endTime = Date.now();
            span.status = 'success';
            this.sendSpan(span);
            return result;
          })
          .catch(error => {
            span.endTime = Date.now();
            span.status = 'error';
            span.error = error.message;
            this.sendSpan(span);
            throw error;
          });
      }
    };
  }
}
```

### Alert Configuration

```typescript
const alertConfig = {
  // Critical alerts (immediate notification)
  critical: [
    {
      name: 'PRIVACY_VIOLATION',
      condition: (m) => m.privacy.unhashed_pii_detected > 0,
      message: 'Unhashed PII detected in signals',
      action: 'Stop processing immediately and investigate'
    },
    {
      name: 'SYSTEM_DOWN',
      condition: (m) => m.performance.throughput_per_sec === 0,
      message: 'Signal processing has stopped',
      action: 'Check system health and restart if needed'
    }
  ],
  
  // Warning alerts (batched notifications)
  warning: [
    {
      name: 'HIGH_LATENCY',
      condition: (m) => m.performance.p95_latency_ms > 2000,
      message: 'Signal processing latency is high'
    },
    {
      name: 'LOW_MATCH_RATE',
      condition: (m) => m.quality.match_rate < 0.5,
      message: 'Identity match rate below 50%'
    }
  ]
};
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