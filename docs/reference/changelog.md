---
sidebar_position: 3
title: Changelog
---

# Protocol Changelog

Track changes and updates to the Ad Context Protocol specifications.

## Version 0.1 - January 2025

### Initial RFC Release

First Request for Comments (RFC) release of the Audience Discovery Protocol.

#### New Features
- **Core Tools**: Implemented all four essential tools
  - `get_audiences`: Natural language audience discovery
  - `activate_audience`: Audience activation for platforms
  - `check_audience_status`: Deployment status monitoring
  - `report_usage`: Daily usage reporting
- **Authentication**: Platform and customer account types
- **Pricing Models**: CPM and revenue share support
- **Size Units**: Individuals, devices, and households reporting

#### Supported Features
- Natural language prompt processing
- Relevance scoring and rationale
- Multi-platform deployment
- Flexible pricing options
- Real-time activation status
- Comprehensive error handling

#### Initial Platform Support
- Reference implementation available
- Validation test suite included
- Documentation and examples provided

---

## Updates - January 2025

### Breaking Changes

#### get_audiences API Restructure
**Breaking Change**: Updated `get_audiences` request structure for improved clarity and geographic targeting.

**Before**:
```json
{
  "prompt": "string",
  "platform": "string", 
  "seat": "string",
  "filters": {
    "regions": ["string"],
    // ... other filters
  }
}
```

**After (v1.1.0)**:
```json
{
  "audience_spec": "string",
  "deliver_to": {
    "platform": "string",
    "seat": "string",
    "countries": ["string"]
  },
  "filters": {
    // ... other filters (regions removed)
  }
}
```

#### Migration Guide
- Replace `prompt` with `audience_spec`
- Move `platform` and `seat` into `deliver_to` object
- Move `filters.regions` to `deliver_to.countries`
- Update client code to use new structure

---

## Upcoming Releases

### Version 1.2.0 - Q2 2025 (Planned)

#### Planned Features
- **Enhanced Filtering**: Additional audience filtering options
- **Batch Operations**: Multi-audience activation support
- **Performance Metrics**: Extended audience performance data
- **Geographic Targeting**: Enhanced location-based filtering

#### API Enhancements
- New optional parameters for `get_audiences`
- Batch activation endpoint
- Enhanced status reporting
- Performance analytics integration

### Version 2.0.0 - Q3 2025 (Planned)

#### Major Changes
- **Curation Protocol**: Media inventory curation capabilities
- **Brand Safety**: Integrated brand safety controls
- **Cross-Protocol**: Audience + inventory bundling
- **Advanced AI**: Improved natural language processing

#### Breaking Changes
- Enhanced prompt processing (backward compatible)
- Extended response formats for new features
- Additional authentication scopes

### Version 3.0.0 - Q4 2025 (Planned)

#### Major Features
- **Media Buy Protocol**: Complete campaign execution
- **Optimization AI**: Automated campaign optimization
- **Real-time Bidding**: RTB integration capabilities
- **Advanced Analytics**: Comprehensive performance tracking

---

## Migration Guides

### Upgrading to Version 1.1.0

When version 1.1.0 is released, existing implementations will remain compatible. New features will be additive:

```typescript
// Existing code continues to work
const result = await getAudiences({
  prompt: "sports enthusiasts"
});

// New features available optionally
const enhancedResult = await getAudiences({
  prompt: "sports enthusiasts",
  // New optional parameters in v1.1
  geographic_filters: {
    countries: ["US", "CA"],
    regions: ["northeast", "west_coast"]
  },
  performance_requirements: {
    min_click_rate: 0.05,
    min_conversion_rate: 0.02
  }
});
```

### Preparing for Version 2.0.0

To prepare for the Curation Protocol integration:

1. **Review Current Usage**: Audit your current audience discovery patterns
2. **Plan Integration**: Consider how inventory curation might enhance your workflows
3. **Test Environment**: Set up testing for new protocol features
4. **Training**: Prepare team for expanded capabilities

---

## Deprecation Policy

The Ad Context Protocol follows semantic versioning with these deprecation guidelines:

### Minor Versions (1.x.0)
- **No Breaking Changes**: All existing functionality remains compatible
- **New Features**: Additive features only
- **Deprecation Warnings**: 6-month notice for any deprecations

### Major Versions (x.0.0)
- **Breaking Changes Allowed**: With migration path provided
- **Deprecation Timeline**: 12-month notice for breaking changes
- **Migration Support**: Tools and documentation provided

### Support Timeline
- **Current Version**: Full support and updates
- **Previous Major**: Security updates for 12 months
- **Legacy Versions**: Best-effort community support

---

## Version History

| Version | Release Date | Status | Support End |
|---------|-------------|---------|-------------|
| 1.1.0   | January 2025 | Current | Active |
| 1.0.0   | January 2025 | Superseded | March 2025 |
| 1.2.0   | Q2 2025 | Planned | - |
| 2.0.0   | Q3 2025 | Planned | - |

---

## Request for Comments (RFC)

### Proposed Changes

#### Enhanced Audience Insights (RFC-001)
**Status**: Under Review  
**Target**: Version 1.1.0

Proposed addition of audience insight data to discovery responses:

```json
{
  "audience_id": "aud_123",
  "insights": {
    "top_interests": ["running", "fitness", "health"],
    "demographic_breakdown": {
      "age_ranges": [
        {"range": "25-34", "percentage": 45},
        {"range": "35-44", "percentage": 35}
      ]
    },
    "geographic_concentration": {
      "top_regions": ["california", "new_york", "texas"]
    }
  }
}
```

**Community Feedback**: [GitHub Discussion #12](https://github.com/adcontextprotocol/adcp/discussions/12)

#### Real-time Audience Sizing (RFC-002)
**Status**: Draft  
**Target**: Version 1.2.0

Proposed real-time audience size updates during activation:

```json
{
  "deployment": {
    "status": "activating",
    "estimated_final_size": {
      "count": 1250000,
      "confidence": 0.85
    }
  }
}
```

### How to Contribute

1. **Join Discussions**: Participate in [GitHub Discussions](https://github.com/adcontextprotocol/adcp/discussions)
2. **Submit RFCs**: Propose changes following the RFC template
3. **Test Implementations**: Try pre-release versions and provide feedback
4. **Documentation**: Help improve documentation and examples

---

## Security Updates

All security-related changes are documented here with CVE references where applicable.

### No Security Issues Reported
As of January 2025, no security vulnerabilities have been reported for the Ad Context Protocol.

#### Security Contact
Report security issues to: security@adcontextprotocol.org

---

## Implementation Notes

### Platform-Specific Updates

#### Scope3 Integration
- **v1.0.0**: Full protocol support
- **Upcoming**: Enhanced audience insights

#### The Trade Desk Integration  
- **v1.0.0**: Core functionality
- **Upcoming**: B2B audience specialization

#### LiveRamp Integration
- **v1.0.0**: Individual-level audiences
- **Upcoming**: Household linking capabilities

---

## Community Contributions

### Contributors

Thanks to the following organizations and individuals who contributed to v1.0.0:

- Scope3 - Reference implementation
- The Trade Desk - B2B use case development  
- LiveRamp - Identity resolution guidance
- Individual contributors: [See GitHub](https://github.com/adcontextprotocol/adcp/contributors)

### How to Contribute

1. **Code**: Submit pull requests for implementations
2. **Documentation**: Improve guides and examples
3. **Testing**: Report bugs and edge cases
4. **Feedback**: Share real-world usage patterns

---

## Related Standards

### Dependencies

- **Model Context Protocol (MCP)**: Base protocol framework
- **JSON Schema**: Request/response validation
- **OAuth 2.0**: Authentication standard
- **ISO 8601**: Date/time formatting

### Complementary Standards

- **IAB Standards**: Audience taxonomy alignment
- **OpenRTB**: Real-time bidding integration (future)
- **VAST/VPAID**: Creative standards (future)

---

Stay updated on protocol changes by:
- Watching the [GitHub repository](https://github.com/adcontextprotocol/adcp)
- Subscribing to announcements@adcontextprotocol.org
- Following [@adcontextprotocol](https://twitter.com/adcontextprotocol)