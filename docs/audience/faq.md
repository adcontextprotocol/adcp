---
sidebar_position: 5
title: FAQ
---

# Frequently Asked Questions

## General Questions

### What is the Ad Context Protocol?

The Ad Context Protocol (ACP) is an open standard that enables AI assistants to interact with advertising platforms through natural language. It's built on the Model Context Protocol (MCP) framework.

### How is this different from existing advertising APIs?

Traditional APIs require technical integration and complex parameter mapping. ACP allows you to describe what you want in natural language, and the AI assistant handles the technical details.

### Which platforms support ACP?

The protocol is designed to be platform-agnostic. Platform support varies - check our [showcase page](../showcase) for current implementations.

## Audience Discovery

### How accurate is natural language audience discovery?

The system provides relevance scores (0-1) and rationales for each match. Scores above 0.8 typically indicate strong relevance. Always review the audience descriptions before activating.

### What's the difference between audience size units?

- **Individuals**: Unique people (best for frequency capping)
- **Devices**: Cookies/device IDs (largest reach, includes multiple devices per person)
- **Households**: Unique homes (good for family/location targeting)

### How long does audience activation take?

- **Already Live**: Immediate use
- **New Activation**: Typically 24-48 hours
- **Complex Audiences**: Up to 72 hours

Check the `estimated_activation_time` field for specific timelines.

### Can I activate the same audience on multiple platforms?

Yes, but you'll need separate activation calls for each platform/seat combination. Each may have different pricing and availability.

## Pricing and Billing

### What pricing models are available?

1. **CPM**: Fixed cost per 1,000 impressions
2. **Revenue Share**: Percentage of your media spend
3. **Both**: Some audiences offer choice
4. **Included**: No additional cost (with media buys)

### How do I choose between CPM and revenue share?

- **CPM**: Predictable costs, good for budget planning
- **Revenue Share**: Scales with success, often better rates for high-spend campaigns

### When do I need to report usage?

- **Daily**: For marketplace audiences by 12:00 UTC
- **Not Required**: For destination audiences (billed with media)
- **Campaign End**: Final reconciliation report

### What happens if I don't report usage?

Unreported usage may result in:
- Estimated billing charges
- Account restrictions
- Audience deactivation

## Technical Questions

### How do I authenticate with the protocol?

Authentication is handled at the MCP session level. Your credentials determine:
- Available audiences
- Pricing rates  
- Platform access
- Account type (platform vs. customer)

### What's the difference between platform and customer accounts?

**Platform Accounts**:
- Access to platform-aggregated audiences
- Platform-negotiated rates
- Can syndicate to customers

**Customer Accounts**:
- Direct relationship pricing
- Specific seat access
- Private audience access

### How do I handle errors?

Common error patterns:
- **404 errors**: Check segment IDs are current
- **Authorization errors**: Verify platform/seat permissions
- **Already activated**: Use `check_audience_status` first
- **Rate limits**: Implement exponential backoff

### Can I integrate this with my existing tools?

Yes! The protocol is designed to complement existing advertising tools. Many platforms offer both traditional APIs and ACP interfaces.

## Data and Privacy

### How is audience data handled?

ACP focuses on audience metadata and activation, not underlying personal data. All data handling follows platform-specific privacy policies and regulations.

### Is this GDPR compliant?

Compliance depends on the underlying platform implementations. ACP provides the interface - platforms maintain their own compliance obligations.

### Can I see the underlying audience data?

No. ACP provides audience descriptions, sizes, and relevance scores, but not individual-level data. This maintains privacy while enabling effective targeting.

## Campaign Management

### How do I know if my campaign is working?

Use the `report_usage` endpoint to track:
- Impression delivery
- Campaign performance
- Spend allocation
- Audience utilization

### Can I pause or stop audience usage?

Audience deactivation depends on the platform. Some support programmatic deactivation, others require manual intervention through platform interfaces.

### How do I optimize audience performance?

1. Monitor relevance scores during discovery
2. Track campaign performance metrics
3. Test multiple audiences for the same objective
4. Use feedback to refine natural language prompts

## Troubleshooting

### Why am I getting low relevance scores?

- **Too broad**: "People who like things" → "Premium coffee enthusiasts in urban areas"
- **Too narrow**: "26-year-old males in Denver who bought Nike yesterday"
- **Unclear intent**: "Good customers" → "High-value repeat purchasers"

### My audience shows as "activating" for days

1. Check `estimated_activation_time` from the original response
2. Use `check_audience_status` for current status
3. Contact platform support if significantly delayed
4. Some complex audiences require manual approval

### Usage reporting is being rejected

Common issues:
- **Missing required fields**: Ensure all mandatory fields are included
- **Date format**: Use YYYY-MM-DD format
- **Negative values**: All counts and costs should be non-negative
- **Currency mismatch**: Match the audience pricing currency

### Getting "unauthorized" errors

Verify:
- Platform credentials are current
- Seat permissions are correct
- Account has access to the specific audience type
- Platform supports the requested operation

## Platform-Specific Notes

### Scope3
- Supports all audience types
- 24-48 hour activation typical
- Prefers revenue share for premium audiences

### The Trade Desk
- Strong B2B audience selection
- Device-level reporting
- CPM pricing preferred

### LiveRamp
- Individual-level audiences
- Fast activation (usually 24 hours)
- Both pricing models available

*Note: Platform capabilities change frequently. Check current documentation for each platform.*

## Getting Help

- **Documentation**: Browse these docs thoroughly
- **Community**: Join [GitHub Discussions](https://github.com/adcontextprotocol/adcp/discussions)
- **Platform Support**: Contact your platform representative for platform-specific issues
- **Technical Issues**: Email support@adcontextprotocol.org