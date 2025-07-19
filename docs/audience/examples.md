---
sidebar_position: 4
title: Implementation Examples
---

# Audience Discovery Examples

This page demonstrates real-world usage of the Audience Discovery Protocol with detailed examples.

## Example 1: Nike Running Campaign

Nike wants to find audiences interested in premium running gear for a new shoe launch.

### Step 1: Discovery

**Request**:
```json
{
  "audience_spec": "High-income runners and marathon enthusiasts who buy premium athletic gear",
  "deliver_to": {
    "platform": "scope3",
    "seat": "nike_us_001",
    "countries": ["US", "CA"]
  },
  "filters": {
    "min_size": 500000,
    "max_cpm": 10.00
  },
  "max_results": 3
}
```

**Response**:
```json
{
  "success": true,
  "audiences": [
    {
      "audience_id": "aud_marathon_2024",
      "segment_id": "seg_12345",
      "name": "Marathon Enthusiasts Premium",
      "description": "Runners who have completed marathons and purchase premium gear",
      "audience_type": "marketplace",
      "provider": "LiveRamp",
      "size": {
        "count": 2500000,
        "unit": "individuals",
        "as_of": "2025-01-15"
      },
      "relevance_score": 0.92,
      "relevance_rationale": "High match for premium running gear buyers with marathon completion history",
      "deployment": {
        "is_live": true,
        "platform": "scope3",
        "seat": "nike_us_001"
      },
      "pricing": {
        "cpm": 8.50,
        "rev_share": null,
        "currency": "USD",
        "notes": "Premium athletic audience"
      }
    },
    {
      "audience_id": "aud_fitness_affluent",
      "segment_id": "seg_67890",
      "name": "Affluent Fitness Enthusiasts",
      "description": "High-income individuals actively engaged in fitness",
      "audience_type": "marketplace",
      "provider": "Experian",
      "size": {
        "count": 850000,
        "unit": "households",
        "as_of": "2025-01-14"
      },
      "relevance_score": 0.78,
      "relevance_rationale": "High income correlation with premium gear purchases",
      "deployment": {
        "is_live": false,
        "estimated_activation_time": "24-48 hours"
      },
      "pricing": {
        "cpm": 12.00,
        "rev_share": 0.15,
        "currency": "USD",
        "notes": "Choice of pricing model available"
      }
    }
  ]
}
```

### Step 2: Activation

Nike decides to activate the "Affluent Fitness Enthusiasts" audience:

**Request**:
```json
{
  "segment_id": "seg_67890",
  "platform": "scope3",
  "seat": "nike_us_001",
  "options": {
    "priority": "high",
    "notification_email": "campaigns@nike.com"
  }
}
```

**Response**:
```json
{
  "success": true,
  "activation": {
    "segment_id": "seg_67890",
    "audience_name": "Affluent Fitness Enthusiasts",
    "platform": "scope3",
    "seat": "nike_us_001",
    "status": "activating",
    "estimated_ready_time": "2025-01-21T10:00:00Z",
    "activation_id": "act_789123",
    "created_at": "2025-01-19T14:30:00Z"
  }
}
```

### Step 3: Status Check

After 24 hours, Nike checks the activation status:

**Request**:
```json
{
  "segment_id": "seg_67890",
  "platform": "scope3",
  "seat": "nike_us_001"
}
```

**Response**:
```json
{
  "success": true,
  "audience": {
    "segment_id": "seg_67890",
    "name": "Affluent Fitness Enthusiasts",
    "size": {
      "count": 850000,
      "unit": "households",
      "as_of": "2025-01-14"
    },
    "deployment": {
      "platform": "scope3",
      "seat": "nike_us_001",
      "status": "deployed",
      "deployed_at": "2025-01-20T09:45:00Z"
    },
    "pricing": {
      "cpm": 12.00,
      "rev_share": 0.15,
      "currency": "USD"
    }
  }
}
```

### Step 4: Usage Reporting

After running campaigns for a day, Nike reports usage:

**Request**:
```json
{
  "reporting_date": "2025-01-21",
  "platform": "scope3",
  "seat": "nike_us_001",
  "usage": [
    {
      "segment_id": "seg_67890",
      "impressions": 1250000,
      "clicks": 3750,
      "media_spend": 85000.00,
      "data_cost": 15000.00,
      "campaigns": [
        {
          "campaign_id": "camp_nike_spring",
          "campaign_name": "Nike Spring Collection 2025",
          "impressions": 1250000,
          "media_spend": 85000.00
        }
      ]
    }
  ],
  "summary": {
    "total_impressions": 1250000,
    "total_media_spend": 85000.00,
    "total_data_cost": 15000.00,
    "unique_segments": 1
  }
}
```

## Example 2: B2B Software Company

A SaaS company wants to target small business owners for their accounting software.

### Discovery Request

```json
{
  "audience_spec": "Small business owners who need accounting software, particularly restaurants and retail stores",
  "deliver_to": {
    "platform": "thetradedesk",
    "seat": "saas_company_001",
    "countries": ["US"]
  },
  "filters": {
    "audience_types": ["marketplace"],
    "min_size": 100000,
    "max_cpm": 15.00
  }
}
```

### Discovery Response

```json
{
  "success": true,
  "audiences": [
    {
      "audience_id": "aud_smb_finance",
      "segment_id": "seg_44556",
      "name": "SMB Finance Decision Makers",
      "description": "Business owners with 5-50 employees who make financial software decisions",
      "audience_type": "marketplace",
      "provider": "ZoomInfo",
      "size": {
        "count": 450000,
        "unit": "individuals",
        "as_of": "2025-01-18"
      },
      "relevance_score": 0.88,
      "relevance_rationale": "Perfect match for business size and financial software needs",
      "deployment": {
        "is_live": false,
        "estimated_activation_time": "48-72 hours"
      },
      "pricing": {
        "cpm": null,
        "rev_share": 0.18,
        "currency": "USD",
        "notes": "B2B revenue share model"
      }
    }
  ]
}
```

## Example 3: Error Handling

### Attempting to Activate Non-Existent Segment

**Request**:
```json
{
  "segment_id": "seg_invalid",
  "platform": "scope3",
  "seat": "test_seat"
}
```

**Error Response**:
```json
{
  "success": false,
  "error": {
    "code": "SEGMENT_NOT_FOUND",
    "message": "Segment ID 'seg_invalid' not found",
    "details": "Please verify the segment_id from a recent get_audiences response"
  }
}
```

### Attempting to Re-Activate Already Active Audience

**Request**:
```json
{
  "segment_id": "seg_12345",
  "platform": "scope3",
  "seat": "nike_us_001"
}
```

**Error Response**:
```json
{
  "success": false,
  "error": {
    "code": "ALREADY_ACTIVATED",
    "message": "Audience is already active for this platform/seat combination",
    "details": {
      "current_status": "deployed",
      "deployed_at": "2025-01-15T08:30:00Z"
    }
  }
}
```

## Common Patterns

### 1. Checking Multiple Pricing Options

Some audiences offer both CPM and revenue share pricing:

```json
{
  "pricing": {
    "cpm": 5.00,
    "rev_share": 0.12,
    "currency": "USD",
    "notes": "Choose the model that works best for your campaign"
  }
}
```

### 2. Size Unit Variations

Different providers report different size units:

```json
// LiveRamp: Individual people
{
  "size": {
    "count": 2500000,
    "unit": "individuals"
  }
}

// Nielsen: Households
{
  "size": {
    "count": 850000,
    "unit": "households"
  }
}

// Google: Devices
{
  "size": {
    "count": 15000000,
    "unit": "devices"
  }
}
```

### 3. Multi-Campaign Reporting

When reporting usage across multiple campaigns:

```json
{
  "usage": [
    {
      "segment_id": "seg_12345",
      "impressions": 2000000,
      "campaigns": [
        {
          "campaign_id": "camp_awareness",
          "impressions": 1200000,
          "media_spend": 45000.00
        },
        {
          "campaign_id": "camp_retargeting", 
          "impressions": 800000,
          "media_spend": 28000.00
        }
      ]
    }
  ]
}
```

## Best Practices

1. **Always check `is_live` status** before planning campaign timelines
2. **Use relevant prompts** - be specific about your target audience characteristics
3. **Consider size units** when comparing audiences (households vs individuals vs devices)
4. **Report usage daily** for accurate billing and platform optimization
5. **Handle errors gracefully** and retry failed operations with exponential backoff