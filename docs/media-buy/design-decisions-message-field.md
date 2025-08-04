---
title: Message Field Pattern
sidebar_position: 10
---

# Design Decision: Universal Message Field Pattern

## Overview

All AdCP task responses now include a `message` field as the first field in the JSON response. This field provides a human-readable summary of the response, making AdCP more conversational and AI-friendly.

## Decision

Add a required `message` field to all task responses:

```json
{
  "message": "string",  // Human-readable summary
  "context_id": "string",
  // ... other structured data
}
```

## Rationale

### 1. AI-Native Design

Modern AI agents can quickly understand responses by reading the message field, without parsing complex JSON structures. This enables:
- Faster response comprehension
- Natural conversation flow
- Reduced token usage for AI agents

### 2. Human-in-the-Loop Support

When humans need to review operations, the message field provides immediate understanding:
- Sales teams can understand campaign status
- Support staff can quickly diagnose issues
- Approvers see clear summaries of what needs approval

### 3. Progressive Disclosure

The pattern supports both simple and complex use cases:
- Quick operations: Read only the message
- Detailed analysis: Parse the full structured data
- Debugging: Both message and data provide context

### 4. Conversational Commerce

The message field enables natural back-and-forth interactions:

```json
// Request clarification
{
  "message": "I'd be happy to help find products for your campaign. Could you share your budget and target audience?",
  "clarification_needed": true,
  "products": []
}

// Provide recommendations
{
  "message": "I found 3 premium CTV products perfect for your sports campaign. Connected TV Prime offers the best reach at $45 CPM.",
  "products": [...]
}
```

## Implementation Guidelines

### Message Content

Messages should be:
1. **Concise** - 1-3 sentences summarizing the key information
2. **Actionable** - Include next steps when relevant
3. **Contextual** - Reference specific values from the request/response
4. **Natural** - Written as if from a knowledgeable colleague

### Examples by Response Type

**Success Response:**
```
"Successfully created your $50,000 media buy targeting pet owners in CA and NY. The campaign will reach 2.5M users. Please upload creatives by January 30 to activate."
```

**Error/Issue Response:**
```
"Your campaign is underdelivering. At 50% of the flight, you've only delivered 35% of impressions. Consider expanding targeting or increasing bid."
```

**Clarification Response:**
```
"I need more information to provide the best recommendations. Could you share your campaign budget, timing, and success metrics?"
```

**Status Update:**
```
"Good progress on activation. Access permissions validated. Now configuring deployment. About 45 minutes remaining."
```

### Message Generation Code Pattern

```python
def generate_message(response_data, request_data, response_type):
    """Generate appropriate message based on response type and data"""
    
    if response_type == "success":
        key_metric = extract_key_metric(response_data)
        next_step = determine_next_step(response_data)
        return f"{describe_success(response_data)} {key_metric}. {next_step}."
    
    elif response_type == "clarification":
        missing_info = identify_missing_info(request_data)
        questions = generate_questions(missing_info)
        return f"I'd be happy to help with your {extract_intent(request_data)}. {questions}"
    
    elif response_type == "warning":
        issue = identify_issue(response_data)
        recommendation = suggest_remediation(issue)
        return f"{describe_issue(issue)}. {recommendation}."
```

## Benefits

1. **Reduced Cognitive Load** - Instant understanding without JSON parsing
2. **Better Error Handling** - Clear explanations of what went wrong
3. **Improved UX** - Natural, conversational interactions
4. **Easier Debugging** - Messages provide context for structured data
5. **Protocol Agnostic** - Works equally well in MCP and A2A contexts

## Migration

For existing implementations:
1. Add message generation to response builders
2. Ensure messages summarize key information
3. Test with both AI agents and human users
4. Monitor message quality and iterate

## Future Considerations

The message field pattern could be extended with:
- Confidence scores for AI-generated messages
- Multiple message types (summary, detail, action)
- Localization support for global markets
- Sentiment indicators for tone management

This pattern establishes AdCP as a truly conversational protocol, ready for the AI-powered future of advertising.