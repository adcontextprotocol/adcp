# Brief Expectations Proposal for AdCP

## Summary

This proposal enhances the `get_products` tool to support conversational interactions while maintaining backward compatibility. The key innovation is adding a universal `message` field to responses, enabling natural agent-to-agent conversations.

## Key Changes

### 1. Response Format Enhancement

Added two new fields to `get_products` responses:
- `message`: Human-readable summary of the response
- `clarification_needed`: Boolean indicating if more information would help

### 2. Conversational Pattern

The tool can now respond in three ways:
1. **Products Found**: Returns products with a helpful summary
2. **Clarification Needed**: Asks for missing information
3. **Policy Issues**: Explains why products can't be shown

### 3. Brief Expectations (Guidelines, not Requirements)

Complete briefs typically include:
- Business objectives (awareness, conversions, etc.)
- Success metrics (CTR, CPA, ROAS, etc.)
- Campaign timing (flight dates)
- Target audience (demographics, interests)
- Budget constraints
- Geographic markets
- Creative constraints
- Brand safety requirements

Publishers will still return relevant products even with incomplete briefs, but may request clarification for better recommendations.

## Example Interactions

### Complete Brief
```json
// Request
{
  "brief": "I need a $50K CTV campaign targeting sports fans in California for Q1 2025, optimizing for app installs",
  "promoted_offering": "Nike Run Club app - free running tracker and coaching"
}

// Response
{
  "message": "I found 3 premium sports-focused CTV products perfect for your app install campaign. Connected TV Sports Package offers the best performance at $35 CPM with a 2.5% average install rate in California.",
  "products": [...],
  "clarification_needed": false
}
```

### Incomplete Brief
```json
// Request
{
  "brief": "I want to advertise my fitness app",
  "promoted_offering": "FitTracker Pro - premium workout planning app"
}

// Response
{
  "message": "I'd be happy to help find the right products for your FitTracker Pro campaign. To provide the best recommendations, could you share:\n\n• What's your campaign budget?\n• When do you want the campaign to run?\n• Which geographic markets are you targeting?\n• What are your success metrics (installs, subscriptions, etc.)?",
  "products": [],
  "clarification_needed": true
}
```

## Benefits

1. **Natural Conversations**: Agents can have back-and-forth discussions
2. **Progressive Disclosure**: Start simple, add detail as needed
3. **Backward Compatible**: Still works as a simple tool call
4. **Protocol Agnostic**: Same pattern works in MCP and A2A
5. **Human-Friendly**: Messages make responses understandable at a glance

## Implementation Impact

- Minimal changes to existing implementations
- Publishers generate appropriate messages based on response type
- Buyers can choose to read just the message or full structured data
- Context preserved through `context_id` for follow-up requests

## Next Steps

1. Apply this pattern to other AdCP tools for consistency
2. Add implementation examples in Python/TypeScript
3. Create best practices guide for message generation
4. Consider adding `confidence` scores to product matches

This approach maintains AdCP's AI-first philosophy while making interactions more natural and helpful.