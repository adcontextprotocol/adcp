# Testing and Development

## Overview

AdCP supports strategy-based testing that enables comprehensive testing of advertising workflows without real-world consequences. Strategies represent complete campaign execution patterns that define business approaches, technical requirements, and testing scenarios.

## Strategy-Based Testing Framework

### Understanding Strategies

Strategies in AdCP represent complete campaign execution patterns, not just optimization parameters. Each strategy defines:

- **Business approach** (audience-driven, inventory-driven, creative-driven)
- **Control relationships** (who controls what: principal vs publisher)
- **Creative requirements** (formats, approval workflows, localization)
- **Performance expectations** (KPIs, optimization goals, success metrics)
- **Error handling patterns** (recovery paths, manual interventions)

Strategies provide **test context continuity** - all operations linked to the same strategy ID share state and behavior patterns.

## Production Strategy Patterns

### Audience-Driven Campaigns

**Example**: `nike-running-enthusiasts-1p-data`

- **Principal brings**: First-party audience data, lookalike modeling
- **Publisher provides**: Inventory matching, reach optimization
- **Focus**: Precision targeting within known audience segments
- **Challenges**: Data integration, privacy compliance, audience overlap

```json
{
  "strategy_characteristics": {
    "data_source": "principal_first_party",
    "targeting_control": "principal",
    "inventory_control": "publisher",
    "optimization_goal": "audience_reach",
    "typical_cpm": "moderate",
    "approval_complexity": "low"
  }
}
```

### Premium Inventory Takeovers

**Example**: `mercedes-homepage-takeover-q4`

- **Principal brings**: Premium budget, brand guidelines
- **Publisher provides**: Premium inventory, creative production support
- **Focus**: Brand impact, guaranteed delivery, premium placement
- **Challenges**: Creative complexity, manual approvals, scheduling conflicts

```json
{
  "strategy_characteristics": {
    "inventory_type": "premium_guaranteed",
    "creative_complexity": "high",
    "approval_workflow": "manual_required",
    "delivery_priority": "guaranteed",
    "typical_cpm": "premium",
    "lead_time": "2_weeks"
  }
}
```

### Agentic Creative Campaigns

**Example**: `spotify-wrapped-dynamic-creative`

- **Principal brings**: Brand guidelines, creative parameters
- **Publisher provides**: Creative generation, A/B testing infrastructure
- **Focus**: Personalization at scale, continuous optimization
- **Challenges**: Brand compliance, creative quality control, performance attribution

```json
{
  "strategy_characteristics": {
    "creative_generation": "ai_powered",
    "personalization": "individual_level",
    "optimization_cycle": "real_time",
    "quality_control": "automated_with_fallbacks",
    "typical_cpm": "variable",
    "testing_complexity": "high"
  }
}
```

### Event-Driven Campaigns

**Example**: `nike-berlin-marathon-q3-takeover`

- **Principal brings**: Event timing, brand activation goals
- **Publisher provides**: Event-specific inventory, localization
- **Focus**: Moment marketing, geographic targeting, time-sensitive delivery
- **Challenges**: Inventory availability, localization, real-time adjustments

```json
{
  "strategy_characteristics": {
    "timing_sensitivity": "critical",
    "geographic_focus": "event_location",
    "inventory_competition": "high",
    "localization_required": true,
    "delivery_window": "narrow",
    "performance_tracking": "real_time"
  }
}
```

## Testing with Strategies

### Simulation Strategies

Test versions of production strategies enable deterministic testing without real-world impact. Simulation strategies use a naming convention (e.g., `sim_` prefix) to distinguish them from production strategies.

**Examples**:
- `sim_audience_buy_happy` - Audience matching succeeds perfectly
- `sim_takeover_approval_delay` - Manual approval takes 48 hours
- `sim_creative_policy_violation` - Creative requires revision
- `sim_budget_exceeded_recovery` - Overspend triggers automatic pause

### Strategy-Linked Operations

All AdCP operations accept an optional `strategy_id` parameter that links operations together and determines behavior:

```json
{
  "tool": "get_products",
  "arguments": {
    "brief": "Homepage takeover for Berlin Marathon week",
    "strategy_id": "sim_nike_marathon_test",
    "requirements": {
      "placement": "homepage",
      "geo": "Berlin, Germany"
    }
  }
}
```

Operations with the same `strategy_id` share:
- **Test context** (simulated vs production behavior)
- **Performance patterns** (success rates, timing, errors)
- **State continuity** (campaign lifecycle, approval status)
- **Data consistency** (metrics, reporting, optimization)

## Complete End-to-End Campaign Flow

### Scenario: Nike Berlin Marathon Homepage Takeover

**Strategy**: `nike-berlin-marathon-q3-takeover`

This example demonstrates the complete orchestrator ↔ publisher flow including human-in-the-loop approvals, error handling, and recovery patterns.

#### Phase 1: Product Discovery

**Orchestrator → Publisher**

```json
{
  "tool": "get_products",
  "arguments": {
    "brief": "Homepage takeover campaign for Nike Berlin Marathon, targeting German running enthusiasts during marathon week September 15-22, 2024",
    "strategy_id": "nike-berlin-marathon-q3-takeover",
    "requirements": {
      "placement_type": "homepage_takeover",
      "geographic_targeting": "Berlin, Germany + 50km radius",
      "date_range": {
        "start": "2024-09-15",
        "end": "2024-09-22"
      },
      "audience": "running_enthusiasts",
      "brand_safety": "premium_sports_content",
      "language": "German"
    },
    "budget_range": {
      "min": 75000,
      "max": 150000,
      "currency": "EUR"
    }
  }
}
```

**Publisher → Orchestrator**

```json
{
  "products": [
    {
      "id": "homepage_takeover_berlin_marathon",
      "name": "Berlin Sports Premium Homepage Takeover",
      "description": "Full homepage takeover on Berlin's leading sports media network during marathon week",
      "inventory_type": "premium_guaranteed",
      "placement": {
        "type": "homepage_takeover",
        "position": "above_fold_full",
        "exclusivity": "category_exclusive"
      },
      "targeting": {
        "geographic": "Berlin_metropolitan_area",
        "demographic": "adults_25_54",
        "interest": "running_fitness_sports",
        "contextual": "marathon_running_content"
      },
      "pricing": {
        "model": "fixed_cpm",
        "cpm_eur": 125.00,
        "minimum_spend": 87500,
        "estimated_impressions": 700000
      },
      "creative_requirements": {
        "formats": [
          "html5_responsive_takeover",
          "video_hero_unit"
        ],
        "dimensions": [
          {"width": 1920, "height": 1080, "type": "desktop_hero"},
          {"width": 390, "height": 844, "type": "mobile_hero"}
        ],
        "file_size_limits": {
          "html5": "2MB",
          "video": "50MB"
        },
        "localization": {
          "required_languages": ["de-DE"],
          "cultural_adaptation": "local_marathon_references"
        }
      },
      "approval_process": {
        "type": "manual_review_required",
        "sla": "48_hours",
        "review_criteria": [
          "brand_safety_premium",
          "cultural_sensitivity_germany",
          "sports_category_alignment"
        ]
      },
      "availability": {
        "status": "available_pending_approval",
        "competition": "moderate",
        "booking_deadline": "2024-09-01"
      }
    }
  ],
  "strategy_context": {
    "strategy_id": "nike-berlin-marathon-q3-takeover",
    "estimated_timeline": {
      "booking_to_approval": "48_hours",
      "creative_to_live": "72_hours",
      "total_lead_time": "14_days"
    }
  }
}
```

#### Phase 2: Campaign Creation with Manual Approval

**Orchestrator → Publisher**

```json
{
  "tool": "create_media_buy",
  "arguments": {
    "strategy_id": "nike-berlin-marathon-q3-takeover",
    "campaign_name": "Nike Berlin Marathon 2024 - Homepage Takeover",
    "products": ["homepage_takeover_berlin_marathon"],
    "budget": {
      "total": 120000,
      "currency": "EUR",
      "pacing": "front_loaded"
    },
    "schedule": {
      "start_date": "2024-09-15T06:00:00+02:00",
      "end_date": "2024-09-22T23:59:59+02:00",
      "timezone": "Europe/Berlin"
    },
    "targeting_overlay": {
      "age_range": "25-54",
      "interests": ["marathon_running", "premium_athletic_wear"],
      "exclude_audiences": ["nike_competitors"]
    },
    "optimization_goal": {
      "primary": "brand_awareness",
      "secondary": "website_visits",
      "kpi_targets": {
        "viewability": 0.85,
        "click_through_rate": 0.015,
        "brand_lift": 0.12
      }
    }
  }
}
```

**Publisher → Orchestrator**

```json
{
  "media_buy_id": "mb_nike_marathon_2024_001",
  "status": "pending_approval",
  "strategy_id": "nike-berlin-marathon-q3-takeover",
  "campaign_details": {
    "name": "Nike Berlin Marathon 2024 - Homepage Takeover",
    "total_budget": 120000,
    "currency": "EUR"
  },
  "approval_workflow": {
    "status": "human_review_required",
    "reason": "premium_inventory_manual_approval",
    "assigned_to": "Premium Inventory Team",
    "estimated_resolution": "2024-08-28T16:00:00+02:00",
    "review_criteria": [
      "budget_allocation_approval",
      "competitor_conflict_check",
      "inventory_availability_final_confirmation"
    ]
  },
  "next_steps": [
    {
      "action": "await_approval",
      "estimated_duration": "48_hours",
      "notification_method": "webhook"
    },
    {
      "action": "creative_submission",
      "required_after": "approval_granted",
      "deadline": "2024-09-01T00:00:00+02:00"
    }
  ],
  "current_time": "2024-08-26T14:30:00+02:00"
}
```

#### Phase 3: Manual Approval Process (Human-in-the-Loop)

**48 Hours Later - Publisher → Orchestrator (Webhook)**

```json
{
  "event": "media_buy_approved",
  "media_buy_id": "mb_nike_marathon_2024_001",
  "strategy_id": "nike-berlin-marathon-q3-takeover",
  "approval_details": {
    "approved_at": "2024-08-28T15:45:00+02:00",
    "approved_by": "Premium Inventory Team",
    "approval_notes": "Campaign approved. Inventory reserved. Creative submission required by Sept 1.",
    "conditions": [
      "creative_must_include_german_translation",
      "marathon_route_references_preferred",
      "nike_branding_guidelines_compliance"
    ]
  },
  "status": "approved_awaiting_creatives",
  "creative_submission_deadline": "2024-09-01T23:59:59+02:00",
  "inventory_reservation": {
    "reserved_until": "2024-09-02T00:00:00+02:00",
    "impressions_allocated": 700000,
    "exclusivity_confirmed": true
  }
}
```

#### Phase 4: Creative Submission with Policy Error

**Orchestrator → Publisher**

```json
{
  "tool": "add_creative_assets",
  "arguments": {
    "media_buy_id": "mb_nike_marathon_2024_001",
    "strategy_id": "nike-berlin-marathon-q3-takeover",
    "assets": [
      {
        "id": "nike_hero_video_en",
        "type": "video",
        "format": "mp4",
        "dimensions": {"width": 1920, "height": 1080},
        "duration_seconds": 30,
        "file_url": "https://nike.s3.amazonaws.com/marathon-hero-english.mp4",
        "metadata": {
          "title": "Just Do It - Berlin Marathon 2024",
          "description": "Inspiring marathon runners to push their limits",
          "language": "en-US",
          "call_to_action": "Shop Marathon Gear"
        }
      },
      {
        "id": "nike_takeover_html",
        "type": "html5",
        "file_url": "https://nike.s3.amazonaws.com/berlin-takeover.zip",
        "metadata": {
          "interactive_elements": ["video_player", "product_carousel"],
          "tracking_pixels": ["nike_analytics", "marathon_performance"],
          "languages": ["en-US"]
        }
      }
    ]
  }
}
```

**Publisher → Orchestrator (Error Response)**

```json
{
  "status": "creative_rejected",
  "media_buy_id": "mb_nike_marathon_2024_001",
  "strategy_id": "nike-berlin-marathon-q3-takeover",
  "errors": [
    {
      "code": "LOCALIZATION_REQUIRED",
      "severity": "blocking",
      "field": "assets[0].metadata.language",
      "message": "German localization required for Berlin market campaign",
      "details": {
        "required_language": "de-DE",
        "provided_language": "en-US",
        "affected_asset": "nike_hero_video_en"
      },
      "remediation": {
        "action_required": "provide_german_version",
        "deadline": "2024-09-01T23:59:59+02:00",
        "suggestions": [
          "Upload German dubbed version",
          "Provide German subtitles",
          "Submit German voice-over track"
        ]
      }
    },
    {
      "code": "CULTURAL_ADAPTATION_RECOMMENDED", 
      "severity": "warning",
      "message": "Consider adding local marathon route references for better cultural resonance",
      "suggestions": [
        "Include Brandenburg Gate imagery",
        "Reference historic marathon route",
        "Add local running community elements"
      ]
    }
  ],
  "approval_blocked": true,
  "next_steps": [
    {
      "action": "revise_creatives",
      "deadline": "2024-09-01T23:59:59+02:00"
    }
  ]
}
```

#### Phase 5: Error Recovery and Creative Revision

**Orchestrator → Publisher (Revised Submission)**

```json
{
  "tool": "add_creative_assets",
  "arguments": {
    "media_buy_id": "mb_nike_marathon_2024_001",
    "strategy_id": "nike-berlin-marathon-q3-takeover",
    "assets": [
      {
        "id": "nike_hero_video_de",
        "type": "video", 
        "format": "mp4",
        "dimensions": {"width": 1920, "height": 1080},
        "duration_seconds": 30,
        "file_url": "https://nike.s3.amazonaws.com/marathon-hero-german.mp4",
        "metadata": {
          "title": "Einfach machen - Berlin Marathon 2024",
          "description": "Marathonläufer inspirieren, ihre Grenzen zu überwinden",
          "language": "de-DE",
          "call_to_action": "Marathon-Ausrüstung kaufen",
          "cultural_elements": [
            "brandenburg_gate_finish_line",
            "berlin_marathon_route_map",
            "local_running_community"
          ]
        }
      },
      {
        "id": "nike_takeover_html_de",
        "type": "html5",
        "file_url": "https://nike.s3.amazonaws.com/berlin-takeover-de.zip",
        "metadata": {
          "interactive_elements": ["video_player", "product_carousel"],
          "tracking_pixels": ["nike_analytics", "marathon_performance"],
          "languages": ["de-DE"],
          "localization": {
            "currency": "EUR",
            "sizing": "EU_sizes",
            "cultural_references": "berlin_marathon_specific"
          }
        }
      }
    ]
  }
}
```

**Publisher → Orchestrator (Approval)**

```json
{
  "status": "creative_approved",
  "media_buy_id": "mb_nike_marathon_2024_001",
  "strategy_id": "nike-berlin-marathon-q3-takeover",
  "approval_details": {
    "approved_at": "2024-08-31T14:20:00+02:00",
    "approved_by": "Creative Review Team",
    "review_notes": "Excellent cultural adaptation. German localization complete. Ready for campaign launch.",
    "compliance_checks": [
      "german_language_verified",
      "cultural_sensitivity_approved", 
      "brand_safety_cleared",
      "technical_specs_validated"
    ]
  },
  "launch_ready": true,
  "campaign_status": "approved_ready_to_launch",
  "launch_date": "2024-09-15T06:00:00+02:00"
}
```

#### Phase 6: Campaign Launch and Monitoring

**Campaign Launch (Automatic)**

**Publisher → Orchestrator (Launch Notification)**

```json
{
  "event": "campaign_launched",
  "media_buy_id": "mb_nike_marathon_2024_001",
  "strategy_id": "nike-berlin-marathon-q3-takeover",
  "launch_details": {
    "launched_at": "2024-09-15T06:00:00+02:00",
    "status": "live_delivering",
    "inventory_status": "serving_ads",
    "initial_metrics": {
      "impressions_served": 0,
      "clicks": 0,
      "spend": 0
    }
  },
  "performance_tracking": {
    "reporting_frequency": "hourly",
    "optimization_enabled": true,
    "alert_thresholds": {
      "low_delivery": 0.8,
      "high_spend_rate": 1.2,
      "low_viewability": 0.75
    }
  }
}
```

**Mid-Campaign Performance Check**

**Orchestrator → Publisher**

```json
{
  "tool": "get_media_buy_delivery",
  "arguments": {
    "media_buy_id": "mb_nike_marathon_2024_001",
    "strategy_id": "nike-berlin-marathon-q3-takeover",
    "reporting_period": {
      "start": "2024-09-15T06:00:00+02:00",
      "end": "2024-09-18T23:59:59+02:00"
    }
  }
}
```

**Publisher → Orchestrator**

```json
{
  "media_buy_id": "mb_nike_marathon_2024_001",
  "strategy_id": "nike-berlin-marathon-q3-takeover",
  "performance_period": {
    "start": "2024-09-15T06:00:00+02:00", 
    "end": "2024-09-18T23:59:59+02:00"
  },
  "metrics": {
    "delivery": {
      "impressions": 420000,
      "impressions_goal": 700000,
      "delivery_rate": 0.6,
      "pacing": "on_track"
    },
    "engagement": {
      "clicks": 6300,
      "click_through_rate": 0.015,
      "viewability_rate": 0.87,
      "video_completion_rate": 0.78
    },
    "spend": {
      "total_spend": 52500,
      "budget_remaining": 67500,
      "average_cpm": 125.00,
      "spend_rate": "optimal"
    },
    "brand_metrics": {
      "brand_awareness_lift": 0.14,
      "purchase_intent_lift": 0.08,
      "ad_recall": 0.23
    }
  },
  "optimization": {
    "status": "active_optimization",
    "adjustments_made": [
      {
        "timestamp": "2024-09-16T14:30:00+02:00",
        "change": "increased_frequency_cap",
        "reason": "maximize_unique_reach",
        "impact": "+12% unique impressions"
      }
    ],
    "recommendations": [
      {
        "type": "budget_reallocation",
        "suggestion": "Increase weekend spending by 15%",
        "expected_impact": "+8% total impressions"
      }
    ]
  },
  "status": "performing_above_expectations"
}
```

#### Phase 7: Campaign Completion and Reporting

**Publisher → Orchestrator (Campaign End)**

```json
{
  "event": "campaign_completed",
  "media_buy_id": "mb_nike_marathon_2024_001",
  "strategy_id": "nike-berlin-marathon-q3-takeover",
  "completion_details": {
    "ended_at": "2024-09-22T23:59:59+02:00",
    "completion_reason": "scheduled_end",
    "final_status": "completed_successfully"
  },
  "final_metrics": {
    "delivery": {
      "total_impressions": 742000,
      "goal_achievement": 1.06,
      "unique_reach": 580000,
      "frequency": 1.28
    },
    "performance": {
      "total_clicks": 11130,
      "final_ctr": 0.015,
      "average_viewability": 0.86,
      "video_completion": 0.81
    },
    "spend": {
      "total_spend": 119750,
      "budget_utilization": 0.998,
      "final_cpm": 125.62
    },
    "brand_impact": {
      "brand_awareness_lift": 0.16,
      "purchase_intent_lift": 0.11,
      "brand_favorability_lift": 0.09,
      "ad_recall": 0.28
    }
  },
  "campaign_success": {
    "kpi_achievement": {
      "viewability_target": "exceeded",
      "ctr_target": "met", 
      "brand_lift_target": "exceeded"
    },
    "overall_assessment": "highly_successful"
  }
}
```

## Testing Patterns

### Pattern 1: Happy Path Testing

Use simulation strategies to test successful campaign flows:

```json
{
  "strategy_id": "sim_takeover_happy_path",
  "expected_behavior": {
    "approval_time": "immediate",
    "creative_approval": "automatic", 
    "delivery_rate": 1.0,
    "performance": "meets_all_kpis"
  }
}
```

### Pattern 2: Human-in-the-Loop Simulation

Test manual approval workflows with controlled timing:

```json
{
  "strategy_id": "sim_manual_approval_48h",
  "hitl_simulation": {
    "approval_delay": "48_hours",
    "approval_probability": 0.95,
    "conditions_added": 2,
    "reviewer_notes": "simulated_feedback"
  }
}
```

### Pattern 3: Error Recovery Testing

Test error handling and recovery patterns:

```json
{
  "strategy_id": "sim_creative_policy_violation",
  "error_simulation": {
    "error_type": "localization_missing",
    "error_timing": "creative_submission",
    "recovery_required": true,
    "recovery_success_rate": 0.9
  }
}
```

### Pattern 4: Parallel Strategy Testing

Test multiple campaigns with different behavior patterns:

```json
{
  "test_scenarios": [
    {
      "strategy_id": "sim_premium_success",
      "campaign_type": "homepage_takeover",
      "expected_performance": "above_benchmark"
    },
    {
      "strategy_id": "sim_audience_challenge", 
      "campaign_type": "audience_targeted",
      "expected_performance": "requires_optimization"
    }
  ]
}
```

## Time Progression Control

### Event-Based Time Jumping

Jump to specific campaign lifecycle events for deterministic testing:

```json
{
  "tool": "simulation_control",
  "arguments": {
    "strategy_id": "sim_test_campaign",
    "action": "jump_to_event",
    "parameters": {
      "event": "creative_approved"
    }
  }
}
```

### Available Events

**Campaign Lifecycle Events**:
- `campaign_created` - Initial setup complete
- `approval_submitted` - Awaiting manual review
- `campaign_approved` - Ready for creative submission
- `creative_submitted` - Creative assets uploaded
- `creative_approved` - Ready for launch
- `campaign_launched` - Live delivery begins
- `campaign_50_percent` - Halfway through schedule
- `optimization_triggered` - Performance adjustment made  
- `campaign_completed` - Natural end reached

**Error Events**:
- `approval_rejected` - Campaign rejected
- `creative_policy_violation` - Creative needs revision
- `budget_exceeded` - Overspend occurred
- `inventory_unavailable` - Inventory shortage
- `technical_error` - Platform issue

**Recovery Events**:
- `error_resolved` - Issue fixed, campaign proceeds
- `manual_intervention` - Human operator involved
- `campaign_paused` - Temporary stop
- `campaign_resumed` - Restart after pause

### Relative Time Advancement

Jump forward by duration for long-term testing:

```json
{
  "tool": "simulation_control",
  "arguments": {
    "strategy_id": "sim_test_campaign", 
    "action": "advance_time",
    "parameters": {
      "duration": "7d",
      "generate_events": true
    }
  }
}
```

### Simulation Reset

Reset campaign to initial state for repeated testing:

```json
{
  "tool": "simulation_control",
  "arguments": {
    "strategy_id": "sim_test_campaign",
    "action": "reset",
    "parameters": {
      "preserve_configuration": true
    }
  }
}
```

## Implementation Requirements

### Core Requirements (All Implementations)

1. **Strategy Parameter Support**
   - Accept `strategy_id` in all operations
   - Link operations with same strategy ID
   - Maintain strategy context across requests

2. **Simulation Mode Detection**
   - Recognize simulation strategies (e.g., `sim_` prefix)
   - Provide deterministic behavior in test mode
   - Clear indication of simulation vs production

3. **Basic Event Progression**
   - Support jumping to key campaign events
   - Time advancement by duration
   - State consistency across time jumps

4. **Error Simulation**
   - Trigger common error scenarios
   - Deterministic error injection
   - Recovery path testing

### Recommended Features

1. **Human-in-the-Loop Simulation**
   - Simulated approval delays
   - Manual intervention points
   - Timeout and escalation handling

2. **Performance Pattern Simulation**
   - Strategy-specific performance curves
   - Realistic metric generation
   - Optimization behavior modeling

3. **Parallel Testing Support**
   - Multiple concurrent strategies
   - Independent strategy contexts
   - Resource isolation between tests

### Advanced Features

1. **Custom Strategy Definition**
   - Configurable strategy behavior
   - Custom error patterns
   - Business-specific scenarios

2. **Comprehensive Analytics**
   - Strategy performance comparison
   - Test coverage metrics
   - Regression detection

3. **Integration Testing**
   - Multi-protocol testing support
   - External system simulation
   - End-to-end workflow validation

## Strategy Configuration

### Strategy Metadata

Each strategy should define its characteristics:

```json
{
  "strategy_id": "nike-berlin-marathon-q3-takeover",
  "strategy_type": "production",
  "category": "event_driven_premium",
  "characteristics": {
    "inventory_type": "premium_guaranteed",
    "approval_complexity": "manual_required",
    "creative_complexity": "high",
    "localization_required": true,
    "timing_sensitivity": "critical",
    "budget_range": "premium"
  },
  "expected_patterns": {
    "approval_time": "48_hours",
    "creative_revisions": 1.2,
    "performance_ramp": "fast",
    "success_probability": 0.92
  }
}
```

### Simulation Strategy Configuration

Test strategies inherit from production patterns but add simulation controls:

```json
{
  "strategy_id": "sim_nike_marathon_test",
  "inherits_from": "nike-berlin-marathon-q3-takeover", 
  "simulation_overrides": {
    "approval_time": "immediate",
    "error_injection": {
      "creative_policy_violation": {
        "probability": 1.0,
        "timing": "first_submission"
      }
    },
    "performance_acceleration": 100,
    "deterministic_seed": 12345
  }
}
```

## Summary

Strategy-based testing provides a powerful framework for comprehensive AdCP testing that:

1. **Reflects Real Business Scenarios** - Strategies represent actual campaign patterns, not artificial test constructs
2. **Enables Deterministic Testing** - Simulation strategies provide predictable behavior for automated testing
3. **Supports Complex Workflows** - Full campaign lifecycles including HITL, errors, and recovery
4. **Facilitates Parallel Testing** - Multiple independent test scenarios can run concurrently
5. **Maintains Context Continuity** - Strategy IDs link all related operations together

This approach enables robust testing of advertising workflows while remaining practical and implementation-agnostic. Publishers can implement basic strategy support and gradually add more sophisticated simulation capabilities based on their testing needs.