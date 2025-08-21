# Testing and Development

## Overview

AdCP servers support time simulation and dry run capabilities to enable comprehensive testing of advertising agents and campaigns without waiting for real-time events or spending actual budgets.

## Problem Statement

Advertising campaigns have inherently long lifecycles that make testing AdCP client implementations impractical:

- **Creative Review**: 2-48 hours for platform approval
- **Learning Phases**: 3-7 days for algorithm optimization
- **Full Campaigns**: 30-90 days typical duration
- **Budget Cycles**: Daily, weekly, or monthly spend patterns

Current testing challenges include:

1. **Time Constraints**: Developers cannot wait days/weeks to test campaign lifecycle handling
2. **Cost Barriers**: Testing with real campaigns costs money and affects real ad delivery
3. **Event Coverage**: Rare events (budget exhaustion, policy violations) are hard to trigger naturally
4. **Regression Testing**: Automated tests need deterministic, fast execution
5. **Demo Scenarios**: Sales demos and training need to show full lifecycles quickly

## Testing Modes

AdCP servers provide two complementary testing modes:

### 1. Time Simulation Mode
Control simulated time to instantly progress through campaign events while maintaining realistic state transitions and metrics.

### 2. Dry Run Mode
Execute all operations without affecting real platforms or spending money, while providing realistic responses and behaviors.

## Architecture Overview

### Core Components

The testing framework consists of four primary components:

1. **Session Manager**: Handles test session lifecycle and isolation
2. **State Engine**: Manages campaign state machines and transitions
3. **Time Simulator**: Controls time progression and event scheduling
4. **Data Generator**: Produces realistic metrics and performance data

## Session Management

### Creating Test Sessions

All test operations require an explicit session for state management:

```http
POST /test_sessions
```

```json
{
  "session_config": {
    "duration": "24h",
    "isolation_level": "full",
    "persistence": "memory",
    "scenario": "standard_campaign",
    "seed": 12345  // For deterministic behavior
  },
  "time_config": {
    "start_time": "2025-01-01T00:00:00Z",
    "progression_mode": "linear",
    "step_size": "1h"
  },
  "resource_limits": {
    "max_campaigns": 100,
    "max_memory_mb": 512,
    "timeout_hours": 24
  }
}
```

Response:
```json
{
  "session_id": "test_session_abc123",
  "expires_at": "2025-01-02T00:00:00Z",
  "endpoints": {
    "base_url": "https://api.example.com/test/abc123",
    "websocket": "wss://api.example.com/test/abc123/events"
  }
}
```

### Request Headers

All subsequent requests include session context:

```http
X-Test-Session-Id: <session_id>  # Required for all test operations
X-Mock-Time: <ISO-8601>          # Set current simulated time
X-Auto-Advance: <boolean>        # Auto-advance to next event
X-Jump-To-State: <state_name>    # Jump to specific state
X-Dry-Run: <boolean>             # Enable dry run mode
X-Test-Scenario: <scenario>      # Trigger test scenarios
```

### Response Headers

```http
X-Session-Id: <session_id>       # Confirms session context
X-Current-Mock-Time: <ISO-8601>  # Current simulated time
X-Current-State: <state_name>    # Current state machine position
X-Next-Event: <event_name>       # Next scheduled event
X-Next-Event-Time: <ISO-8601>    # When next event occurs
X-Dry-Run-Mode: <boolean>        # Confirms dry run active
X-Simulated-Cost: <decimal>      # Would-be cost (dry run)
```

## State Machine Specification

### Campaign State Model

Campaigns follow a directed graph of states with conditional transitions:

```json
{
  "campaign_state_machine": {
    "states": {
      "created": {
        "type": "initial",
        "data_requirements": ["budget", "targeting", "schedule"],
        "timeout": "1h"
      },
      "pending_review": {
        "type": "intermediate",
        "substates": ["creative_review", "policy_check", "inventory_validation"],
        "min_duration": "2h",
        "max_duration": "48h"
      },
      "active": {
        "type": "intermediate",
        "substates": ["learning", "optimizing", "delivering"],
        "data_requirements": ["approved_creatives", "valid_budget"]
      },
      "learning": {
        "type": "intermediate",
        "entry_conditions": ["min_budget_100", "approved_creatives"],
        "exit_conditions": {
          "success": ["50_conversions", "3_days_elapsed"],
          "failure": ["insufficient_data", "budget_exhausted"]
        },
        "metrics_threshold": {
          "impressions": 10000,
          "conversions": 10
        }
      },
      "optimizing": {
        "type": "intermediate",
        "optimization_factors": ["cpa", "ctr", "viewability"],
        "adjustment_frequency": "6h"
      },
      "paused": {
        "type": "intermediate",
        "reasons": ["manual", "budget_exhausted", "schedule", "error"],
        "resumable": true
      },
      "completed": {
        "type": "terminal",
        "reasons": ["schedule_end", "budget_exhausted", "manual_stop"]
      },
      "failed": {
        "type": "terminal",
        "reasons": ["policy_violation", "payment_failed", "account_suspended"]
      }
    },
    "transitions": {
      "created": [
        {"to": "pending_review", "condition": "all_required_fields"},
        {"to": "failed", "condition": "invalid_configuration"}
      ],
      "pending_review": [
        {"to": "active", "condition": "approved"},
        {"to": "created", "condition": "needs_revision"},
        {"to": "failed", "condition": "rejected"}
      ],
      "active": [
        {"to": "learning", "condition": "new_campaign"},
        {"to": "optimizing", "condition": "learning_complete"},
        {"to": "paused", "condition": "pause_trigger"},
        {"to": "completed", "condition": "end_condition"}
      ],
      "learning": [
        {"to": "optimizing", "condition": "sufficient_data"},
        {"to": "paused", "condition": "performance_issue"},
        {"to": "failed", "condition": "learning_failed"}
      ],
      "paused": [
        {"to": "active", "condition": "manual_resume"},
        {"to": "completed", "condition": "schedule_end"},
        {"to": "failed", "condition": "timeout"}
      ]
    },
    "state_data": {
      "learning": {
        "min_duration": "3d",
        "conversion_threshold": 10,
        "impression_threshold": 10000,
        "data_gathering_rate": "exponential_decay"
      },
      "optimizing": {
        "adjustment_frequency": "6h",
        "optimization_algorithm": "gradient_descent",
        "performance_targets": {
          "cpa": "target * 0.9",
          "ctr": "vertical_benchmark * 1.1"
        }
      }
    }
  }
}
```

### Event Model

Events trigger state transitions and can be scheduled or immediate:

```json
{
  "event_types": {
    "scheduled": [
      "budget_check",
      "performance_evaluation",
      "optimization_cycle",
      "report_generation"
    ],
    "triggered": [
      "creative_approved",
      "budget_exhausted",
      "policy_violation",
      "manual_intervention"
    ],
    "conditional": [
      "learning_complete",
      "performance_threshold_met",
      "anomaly_detected"
    ]
  },
  "event_scheduling": {
    "mode": "priority_queue",
    "resolution": "1m",
    "max_lookahead": "90d",
    "dependency_resolution": "topological_sort"
  }
}
```

## Time Simulation Engine

### Time Progression Mechanics

The time simulation engine controls how simulated time advances:

```json
{
  "time_engine": {
    "clock_resolution": "1m",
    "max_simulation_window": "90d",
    "progression_modes": {
      "linear": {
        "step_size": "1h",
        "speed_multiplier": 1
      },
      "exponential": {
        "initial_step": "1h",
        "growth_factor": 1.5,
        "max_step": "1d"
      },
      "event_driven": {
        "mode": "next_significant_event",
        "look_ahead_window": "7d",
        "event_priorities": ["state_change", "budget_milestone", "optimization"]
      },
      "realistic": {
        "business_hours_weight": 2.0,
        "weekend_weight": 0.5,
        "holiday_calendar": "us_holidays"
      }
    },
    "pause_conditions": [
      {"type": "budget_threshold", "value": 0.9},
      {"type": "performance_anomaly", "deviation": 3.0},
      {"type": "manual_approval_required"},
      {"type": "error_state"}
    ],
    "event_scheduling": {
      "queue_type": "priority_heap",
      "max_concurrent_events": 100,
      "event_resolution": "deterministic",
      "conflict_resolution": "priority_then_fifo"
    }
  }
}
```

### Time Control API

```http
POST /test_sessions/{session_id}/time/advance
```

```json
{
  "advance_mode": "to_event|by_duration|to_time",
  "target": "learning_complete|24h|2025-01-15T00:00:00Z",
  "options": {
    "generate_intermediate_events": true,
    "respect_business_hours": true,
    "apply_variance": true
  }
}
```

## Data Generation Framework

### Synthetic Metrics Generation

Realistic performance data based on industry patterns:

```json
{
  "metric_generation": {
    "baseline_models": {
      "ctr": {
        "vertical_benchmarks": {
          "retail": 0.02,
          "finance": 0.015,
          "automotive": 0.025
        },
        "variance_model": "log_normal",
        "variance_coefficient": 0.15
      },
      "cpm": {
        "auction_dynamics": "second_price",
        "competition_factor": "time_of_day",
        "floor_price": 0.50,
        "ceiling_price": 50.00
      },
      "conversion_rate": {
        "funnel_model": "exponential_decay",
        "attribution_window": "7d",
        "view_through_weight": 0.1
      }
    },
    "performance_curves": {
      "learning_phase": {
        "model": "sigmoid",
        "parameters": {
          "midpoint": "3d",
          "steepness": 0.5,
          "plateau_performance": 0.8
        }
      },
      "daily_patterns": {
        "peak_hours": [12, 20],
        "valley_hours": [3, 4],
        "amplitude": 0.3
      },
      "weekly_patterns": {
        "monday": 0.9,
        "tuesday": 0.95,
        "wednesday": 1.0,
        "thursday": 1.0,
        "friday": 0.95,
        "saturday": 0.8,
        "sunday": 0.85
      }
    },
    "correlation_matrix": {
      "ctr_cpm": -0.3,
      "ctr_conversion": 0.6,
      "spend_impressions": 0.95
    },
    "anomaly_injection": {
      "probability": 0.02,
      "types": ["spike", "drop", "gradual_shift"],
      "magnitude_range": [2, 5]
    }
  }
}
```

### Data Generation API

```python
# Request specific metrics pattern
POST /test_sessions/{session_id}/metrics/generate
{
  "campaign_id": "mb_123",
  "time_range": {
    "start": "2025-01-01T00:00:00Z",
    "end": "2025-01-07T00:00:00Z"
  },
  "model": "realistic|synthetic|replay",
  "parameters": {
    "vertical": "retail",
    "seasonality": "q4_holiday",
    "competition_level": "high",
    "budget_pacing": "aggressive"
  }
}
```

## Concurrency and Isolation

### Isolation Models

```json
{
  "isolation_configuration": {
    "levels": {
      "full": {
        "description": "Complete isolation between test sessions",
        "shared_resources": [],
        "state_visibility": "none",
        "use_case": "parallel_testing"
      },
      "campaign": {
        "description": "Isolation at campaign level",
        "shared_resources": ["account_settings", "creative_library"],
        "state_visibility": "read_only",
        "use_case": "multi_campaign_testing"
      },
      "shared": {
        "description": "Shared state with conflict resolution",
        "shared_resources": ["all"],
        "state_visibility": "read_write",
        "conflict_resolution": "last_write_wins",
        "use_case": "integration_testing"
      }
    },
    "resource_management": {
      "locking_strategy": "optimistic",
      "deadlock_detection": "timeout_based",
      "resource_pools": {
        "campaigns": {"max_per_session": 100},
        "creatives": {"max_per_session": 1000},
        "memory_mb": {"max_per_session": 512}
      }
    },
    "concurrency_control": {
      "max_concurrent_sessions": 1000,
      "max_sessions_per_account": 10,
      "session_timeout": "24h",
      "cleanup_strategy": "lazy_deletion"
    }
  }
}
```

### Session Coordination

```http
POST /test_sessions/{session_id}/coordinate
```

```json
{
  "coordination_type": "synchronized_start|checkpoint|barrier",
  "participants": ["session_1", "session_2", "session_3"],
  "synchronization_point": "all_campaigns_active",
  "timeout": "5m"
}
```

## Error Injection Framework

### Granular Error Control

```json
{
  "error_injection": {
    "strategies": {
      "deterministic": {
        "trigger": "event_count|time_elapsed|state_entry",
        "condition": "5th_request|30m|learning_phase"
      },
      "probabilistic": {
        "probability": 0.1,
        "distribution": "uniform|poisson|burst"
      },
      "scenario_based": {
        "scenario": "payment_gateway_outage",
        "affected_operations": ["create_media_buy", "update_budget"],
        "duration": "2h"
      }
    },
    "error_types": {
      "transient": {
        "retry_behavior": "exponential_backoff",
        "max_retries": 3,
        "examples": ["timeout", "rate_limit", "temporary_unavailable"]
      },
      "permanent": {
        "recovery_required": true,
        "examples": ["invalid_creative", "policy_violation", "insufficient_funds"]
      },
      "cascading": {
        "propagation": "downstream|upstream|lateral",
        "affected_entities": ["related_campaigns", "shared_budget"],
        "examples": ["account_suspension", "platform_outage"]
      }
    },
    "injection_points": {
      "before_state_transition": ["validation_error", "precondition_failure"],
      "during_processing": ["timeout", "resource_exhaustion"],
      "after_completion": ["rollback", "partial_success"]
    },
    "recovery_paths": {
      "automatic": ["retry", "fallback", "circuit_breaker"],
      "manual": ["approval_required", "data_correction"],
      "compensating": ["refund", "credit", "make_good"]
    }
  }
}
```

### Error Injection API

```http
POST /test_sessions/{session_id}/errors/inject
```

```json
{
  "injection_plan": [
    {
      "timing": "at_event",
      "event": "creative_review_complete",
      "error_type": "policy_violation",
      "details": {
        "code": "MISLEADING_CLAIMS",
        "affected_assets": ["headline_1"],
        "remediation_required": true
      }
    },
    {
      "timing": "after_duration",
      "duration": "2h",
      "error_type": "budget_exhaustion",
      "recovery": "pause_campaign"
    }
  ]
}
```

## Resource Management

### Memory and Performance Controls

```json
{
  "resource_management": {
    "memory": {
      "allocation_strategy": "fixed_pool|dynamic",
      "max_heap_size_mb": 512,
      "gc_strategy": "generational",
      "cache_policy": "lru",
      "cache_size_mb": 64
    },
    "compute": {
      "cpu_limit": 2.0,
      "max_concurrent_operations": 50,
      "operation_timeout_ms": 5000,
      "priority_queuing": true
    },
    "storage": {
      "persistence_mode": "memory|disk|hybrid",
      "max_disk_usage_gb": 10,
      "compression": "gzip",
      "retention_policy": {
        "active_sessions": "unlimited",
        "completed_sessions": "7d",
        "failed_sessions": "24h"
      }
    },
    "network": {
      "rate_limiting": {
        "requests_per_second": 100,
        "burst_size": 200
      },
      "bandwidth_simulation": {
        "latency_ms": 50,
        "jitter_ms": 10,
        "packet_loss": 0.001
      }
    },
    "cleanup": {
      "strategy": "immediate|lazy|scheduled",
      "trigger": "session_end|timeout|memory_pressure",
      "grace_period": "1h"
    }
  }
}
```

## Extensibility Framework

### Plugin Architecture

```json
{
  "extensibility": {
    "plugin_interfaces": {
      "state_machine": {
        "custom_states": true,
        "custom_transitions": true,
        "validation_hooks": ["pre_transition", "post_transition"]
      },
      "time_engine": {
        "custom_progression_modes": true,
        "event_interceptors": true,
        "time_manipulation_hooks": ["before_advance", "after_advance"]
      },
      "data_generator": {
        "custom_models": true,
        "metric_transformers": true,
        "data_sources": ["synthetic", "replay", "external"]
      },
      "error_injector": {
        "custom_error_types": true,
        "injection_strategies": true,
        "recovery_handlers": true
      }
    },
    "implementation_hooks": {
      "yahoo_extensions": {
        "gam_simulation": "mock_line_item_creation",
        "inventory_modeling": "realistic_availability",
        "audience_simulation": "yahoo_1p_signals",
        "reporting_pipeline": "simulated_dtf_generation"
      },
      "google_extensions": {
        "dv360_integration": "mock_api_responses",
        "cm360_tracking": "simulated_conversions",
        "ga4_events": "synthetic_analytics"
      },
      "custom_platforms": {
        "registration": "plugin_manifest.json",
        "capabilities": ["state_extension", "metric_generation"],
        "api_version": "1.0"
      }
    },
    "configuration_override": {
      "precedence": ["session", "plugin", "global"],
      "validation": "schema_based",
      "hot_reload": true
    }
  }
}
```

### Custom Implementation Example

```python
class CustomTimeEngine(TimeEnginePlugin):
    def __init__(self, config):
        self.config = config
        
    def advance_time(self, current_time, target):
        # Custom time progression logic
        events = self.generate_intermediate_events(current_time, target)
        return self.apply_business_rules(events)
        
    def register_hooks(self):
        return {
            "before_advance": self.validate_time_jump,
            "after_advance": self.update_metrics,
            "on_event": self.handle_custom_event
        }
```

### Jumpable States

States that can be jumped to via `X-Jump-To-State`:

#### Creative Lifecycle
- `creatives_uploaded` - Assets received by platform
- `creatives_processing` - Platform processing assets
- `creatives_processed` - Processing complete
- `creative_review_started` - Policy review initiated
- `creative_review_complete` - Review finished
- `creative_approved` - Approved for delivery
- `creative_rejected` - Failed policy review

#### Campaign Lifecycle
- `campaign_created` - Initial setup complete
- `campaign_approved` - Ready to start delivery
- `campaign_started` - Delivery begins
- `learning_phase_started` - Algorithm optimization begins
- `learning_phase_complete` - Optimization stable
- `campaign_paused` - Temporarily stopped
- `campaign_resumed` - Restarted after pause
- `campaign_ended` - Natural completion

#### Performance Events
- `first_impression` - Initial ad served
- `first_click` - Initial engagement
- `first_conversion` - Initial success metric
- `optimization_applied` - Algorithm adjustment made
- `performance_plateau` - Metrics stabilized

#### Budget Events
- `budget_10_percent` - 10% spent
- `budget_25_percent` - 25% spent
- `budget_50_percent` - 50% spent
- `budget_75_percent` - 75% spent
- `budget_90_percent` - 90% spent (pace warning)
- `budget_exhausted` - 100% spent

#### Error Events
- `policy_violation` - Content policy issue
- `payment_failed` - Billing problem
- `platform_error` - Technical issue
- `account_suspended` - Access revoked

### Test Scenarios

Pre-defined scenarios accessible via `X-Test-Scenario`:

#### Success Scenarios
- `success_campaign` - Normal progression, achieves target CPA
- `high_performance` - Exceeds KPI targets significantly
- `gradual_optimization` - Slow but steady improvement

#### Failure Scenarios
- `policy_violation` - Creative rejected, requires revision
- `learning_failure` - Insufficient conversions, optimization struggles
- `budget_exhaustion` - Rapid spend without conversions
- `account_suspension` - Mid-campaign account issue

#### Edge Cases
- `intermittent_delivery` - Start-stop patterns
- `seasonal_variation` - Time-based performance changes
- `competitive_pressure` - Auction dynamics simulation

## API Examples

### Example 1: Complete Campaign Lifecycle Test

```python
# Step 1: Create test session
POST /test_sessions
Body: {
  "session_config": {
    "duration": "4h",
    "isolation_level": "full",
    "scenario": "standard_campaign"
  },
  "time_config": {
    "start_time": "2025-01-01T09:00:00Z",
    "progression_mode": "event_driven"
  }
}

Response: {
  "session_id": "test_abc123",
  "expires_at": "2025-01-01T13:00:00Z",
  "base_url": "https://api.example.com/test/abc123"
}

# Step 2: Create campaign in test session
POST /test/abc123/create_media_buy
Headers: {
  "X-Test-Session-Id": "test_abc123",
  "X-Mock-Time": "2025-01-01T09:00:00Z"
}
Body: {
  "name": "Test Campaign",
  "budget": 1000.00,
  "products": ["prod_123"],
  "schedule": {
    "start_date": "2025-01-01",
    "end_date": "2025-01-31"
  }
}

Response: {
  "media_buy_id": "mb_test_123",
  "status": "pending_review",
  "current_state": "created",
  "session_id": "test_abc123",
  "simulated_time": "2025-01-01T09:00:00Z",
  "next_transition": {
    "to_state": "pending_review",
    "estimated_time": "2025-01-01T09:30:00Z"
  }
}

# Step 3: Jump to learning complete state
POST /test/abc123/time/advance
Headers: {
  "X-Test-Session-Id": "test_abc123"
}
Body: {
  "advance_mode": "to_state",
  "target": "optimizing",
  "campaign_id": "mb_test_123",
  "options": {
    "generate_intermediate_events": true
  }
}

Response: {
  "campaign_id": "mb_test_123",
  "current_state": "optimizing",
  "simulated_time": "2025-01-06T09:00:00Z",
  "events_generated": [
    {"time": "2025-01-01T11:00:00Z", "event": "campaign_approved"},
    {"time": "2025-01-02T00:00:00Z", "event": "campaign_started"},
    {"time": "2025-01-02T00:00:00Z", "event": "learning_phase_started"},
    {"time": "2025-01-06T00:00:00Z", "event": "learning_phase_complete"}
  ],
  "metrics": {
    "impressions": 50000,
    "clicks": 500,
    "conversions": 50,
    "spend": 500.00,
    "cpa": 10.00,
    "learning_confidence": 0.95
  }
}
```

### Example 2: Error Injection Testing

```python
# Configure error injection for policy violation
POST /test/abc123/errors/inject
Headers: {
  "X-Test-Session-Id": "test_abc123"
}
Body: {
  "injection_plan": [{
    "timing": "at_state",
    "state": "pending_review",
    "error_type": "policy_violation",
    "details": {
      "code": "MISLEADING_CLAIMS",
      "affected_assets": ["headline_1", "description_2"],
      "severity": "blocking"
    }
  }]
}

# Trigger the error by adding creatives
POST /test/abc123/add_creative_assets
Headers: {
  "X-Test-Session-Id": "test_abc123"
}
Body: {
  "media_buy_id": "mb_test_123",
  "assets": [{
    "type": "headline",
    "content": "Best Product Ever"
  }]
}

Response: {
  "status": "rejected",
  "session_id": "test_abc123",
  "current_state": "pending_review",
  "errors": [{
    "code": "MISLEADING_CLAIMS",
    "message": "Headline contains misleading claims (injected error)",
    "field": "headline_1",
    "severity": "blocking",
    "remediation": {
      "action_required": "revise_content",
      "suggestions": ["Remove superlative claims", "Add substantiation"]
    }
  }],
  "state_transition_blocked": true
}
```

### Example 3: Concurrent Campaign Testing

```python
# Create session with multiple campaigns
POST /test_sessions
Body: {
  "session_config": {
    "isolation_level": "campaign",
    "max_campaigns": 3
  }
}

Response: {"session_id": "test_multi_456"}

# Launch three campaigns with different scenarios
campaigns = [
  {"id": "mb_1", "scenario": "high_performance"},
  {"id": "mb_2", "scenario": "learning_failure"},
  {"id": "mb_3", "scenario": "budget_exhaustion"}
]

# Coordinate synchronized time advancement
POST /test/multi_456/coordinate
Body: {
  "coordination_type": "synchronized_start",
  "participants": ["mb_1", "mb_2", "mb_3"],
  "synchronization_point": "all_campaigns_active"
}

# Advance all campaigns to day 7
POST /test/multi_456/time/advance
Body: {
  "advance_mode": "by_duration",
  "target": "7d",
  "apply_to_all": true
}

Response: {
  "session_id": "test_multi_456",
  "simulated_time": "2025-01-08T00:00:00Z",
  "campaign_states": {
    "mb_1": {
      "state": "optimizing",
      "performance": "exceeding_target",
      "spend": 700.00,
      "roas": 4.5
    },
    "mb_2": {
      "state": "learning",
      "performance": "below_threshold",
      "spend": 450.00,
      "conversions": 2,
      "warning": "insufficient_data_for_optimization"
    },
    "mb_3": {
      "state": "paused",
      "reason": "budget_exhausted",
      "spend": 1000.00,
      "exhausted_at": "2025-01-05T14:23:00Z"
    }
  }
}
```

## Implementation Requirements

### Minimum Requirements (Phase 1)

All AdCP implementations MUST support:

1. **Session Management**
   - Create, retrieve, and delete test sessions
   - Session isolation (at minimum "full" level)
   - Session expiration and cleanup
   - Unique session identifiers

2. **Basic Dry Run Mode**
   - No side effects on production systems
   - Clear indication of test mode in responses
   - Simulated responses for all operations

3. **State Tracking**
   - Campaign state machine with basic states
   - State transition validation
   - State persistence within session

4. **Error Handling**
   - Deterministic error injection
   - Standard error scenarios
   - Recovery path simulation

### Recommended Features (Phase 2)

Implementations SHOULD support:

1. **Time Simulation**
   - Linear time progression
   - Jump to specific states
   - Event generation

2. **Metrics Generation**
   - Basic performance curves
   - Industry-standard benchmarks
   - Correlation between metrics

3. **Concurrency**
   - Multiple concurrent sessions
   - Campaign-level isolation
   - Basic resource limits

### Advanced Features (Phase 3)

Implementations MAY support:

1. **Advanced Time Control**
   - Multiple progression modes
   - Business hour simulation
   - Complex event scheduling

2. **Sophisticated Data Generation**
   - Machine learning models
   - Historical replay
   - Anomaly injection

3. **Full Extensibility**
   - Plugin architecture
   - Custom state machines
   - Platform-specific extensions

### Compliance Validation

```json
{
  "compliance_levels": {
    "basic": {
      "required_features": [
        "session_management",
        "dry_run_mode",
        "state_tracking",
        "error_injection"
      ],
      "test_suite": "adcp-test-basic"
    },
    "standard": {
      "includes": "basic",
      "additional_features": [
        "time_simulation",
        "metrics_generation",
        "concurrent_sessions"
      ],
      "test_suite": "adcp-test-standard"
    },
    "advanced": {
      "includes": "standard",
      "additional_features": [
        "advanced_time_control",
        "ml_data_generation",
        "plugin_architecture"
      ],
      "test_suite": "adcp-test-advanced"
    }
  }
}
```

## Security Considerations

### Isolation Requirements

```json
{
  "security_requirements": {
    "isolation": {
      "production_separation": "mandatory",
      "data_segregation": "complete",
      "api_endpoints": "separate_or_flagged",
      "database_access": "read_only_or_synthetic"
    },
    "authentication": {
      "required": true,
      "test_credentials": "separate_namespace",
      "permissions": "test_specific_roles",
      "audit_logging": "test_flagged"
    },
    "data_protection": {
      "pii_handling": "synthetic_only",
      "real_data_access": "prohibited",
      "data_generation": "deterministic_synthetic",
      "export_restrictions": "test_data_only"
    },
    "resource_protection": {
      "rate_limiting": "enforced",
      "resource_quotas": "per_session",
      "dos_protection": "circuit_breakers",
      "cost_controls": "zero_real_spend"
    }
  }
}
```

### Compliance Requirements

- **GDPR**: No real user data in test environments
- **CCPA**: Synthetic data only for California residents
- **SOC2**: Audit trails for all test operations
- **PCI**: No real payment processing in test mode

## Best Practices

### Clear Mode Indication

Every response in test mode should clearly indicate its status:

```json
{
  "result": {...},
  "test_mode": {
    "dry_run": true,
    "simulated_time": "2025-01-06T09:00:00Z",
    "warning": "This is simulated data for testing only"
  }
}
```

### Deterministic Behavior

Given the same inputs and scenario, results should be reproducible:

```python
# Seed random generators
random.seed(hash(campaign_id + scenario))

# Use consistent time progressions
time_deltas = STANDARD_EVENT_TIMELINE[event_name]
```

### Realistic Constraints

Maintain platform constraints even in simulation:

- Minimum budgets still apply
- Targeting restrictions enforced
- Creative specifications validated
- Rate limits respected

## Use Cases

### 1. Development Testing

```python
def test_campaign_lifecycle():
    # Create campaign
    campaign = client.create_media_buy(
        budget=1000,
        headers={"X-Dry-Run": "true"}
    )
    
    # Jump through key events
    for event in ["campaign_started", "learning_phase_complete"]:
        result = client.get_delivery(
            campaign.id,
            headers={"X-Jump-To-Event": event}
        )
        assert result.status == expected_status[event]
```

### 2. CI/CD Pipeline

```yaml
test:
  script:
    - export ADCP_DRY_RUN=true
    - pytest tests/campaigns --adcp-scenario=success_campaign
    - pytest tests/errors --adcp-scenario=policy_violation
```

### 3. Interactive Demos

```python
# Sales demo showing full month in 5 minutes
demo = ADCPDemo(dry_run=True, auto_advance=True)
demo.create_campaign(budget=10000)
demo.show_timeline(compress_30_days_to_5_minutes=True)
```

### 4. Training Environment

```python
# Safe sandbox for new users
training_client = ADCPClient(
    dry_run=True,
    test_scenario="training_mode"
)
# All operations safe, no real costs
```

## Benefits

1. **Accelerated Development**: Test full lifecycles in seconds instead of weeks
2. **Comprehensive Testing**: Cover edge cases and error scenarios deterministically
3. **Cost Reduction**: No real advertising spend required for testing
4. **Risk Mitigation**: Test in isolation from production systems
5. **Better Demos**: Show complete workflows in real-time presentations
6. **Faster Onboarding**: Safe environment for learning the platform

## Migration Path

### Phase 1: Basic Dry Run (Required)
- Implement `X-Dry-Run` header support
- Return simulated responses for all operations
- No side effects on real platforms

### Phase 2: Time Simulation (Recommended)
- Add `X-Mock-Time` support
- Implement `X-Jump-To-Event` for key events
- Provide realistic metrics progression

### Phase 3: Advanced Scenarios (Optional)
- Support `X-Test-Scenario` for complex workflows
- Add `X-Auto-Advance` for timeline progression
- Implement webhook simulation

## Implementation Considerations

### Cost Tracking
Dry run mode tracks accumulated "would-be" costs for budget planning and forecasting.

### Scenario Flexibility
Test scenarios can be standardized across AdCP implementations, with room for platform-specific extensions.

### Time Boundaries
Time jumping is typically limited to reasonable campaign durations (e.g., 90 days forward) to maintain realistic simulations.

### Webhook Handling
Webhooks are queued and can be retrieved for inspection in dry run mode, but are not delivered to actual endpoints.

### Test Data
Implementations should provide standard test data sets (creatives, targeting, etc.) for consistency across platforms.

### Performance Modeling
Metric generation follows realistic performance curves based on industry standards, with platform-specific variations allowed.

### State Persistence
Test campaign state can persist across sessions based on implementation needs, with clear reset mechanisms available.

## Related Work

- [Stripe Test Mode](https://stripe.com/docs/testing) - Comprehensive test card numbers and scenarios
- [Google Ads API Test Accounts](https://developers.google.com/google-ads/api/docs/test-accounts) - Isolated test environment
- [AWS Time Injection](https://docs.aws.amazon.com/timestream/latest/developerguide/time-injection.html) - Time-series testing
- [Facebook Marketing API Sandbox](https://developers.facebook.com/docs/marketing-api/sandbox) - Ad account simulation

## Implementation Decision Matrix

| Feature | Required | Recommended | Optional | Complexity |
|---------|----------|-------------|----------|------------|
| Session Management | ✓ | | | Low |
| Basic Dry Run | ✓ | | | Low |
| State Machine | ✓ | | | Medium |
| Error Injection | ✓ | | | Low |
| Time Simulation | | ✓ | | Medium |
| Metrics Generation | | ✓ | | Medium |
| Concurrency | | ✓ | | High |
| Advanced Time Control | | | ✓ | High |
| ML Data Generation | | | ✓ | Very High |
| Plugin Architecture | | | ✓ | High |

## Summary

This testing framework provides a comprehensive architecture for AdCP implementations to enable robust testing without real-world consequences. The session-based approach with formal state machines addresses the complexity of advertising workflows while maintaining deterministic behavior.

### Key Architectural Decisions

1. **Session-Based State Management**: Explicit sessions provide isolation and resource control
2. **State Machine Formalization**: Graph-based states enable complex workflow testing
3. **Pluggable Components**: Extensibility allows platform-specific customization
4. **Phased Implementation**: Progressive enhancement from basic to advanced features

Implementations can start with basic dry run capabilities and progressively add sophisticated features based on their needs and resources.