---
sidebar_position: 5
title: Certification
---

# ACP Platform Certification

Official certification program for Ad Context Protocol implementations.

## Certification Overview

The ACP Certification Program ensures that platform implementations meet quality, performance, and security standards for reliable industry adoption.

### Benefits of Certification

**For Platform Providers**:
- Official ACP compliance badge and listing
- Marketing and promotion support
- Technical validation and credibility
- Access to certification-only resources

**For Users**:
- Confidence in implementation quality
- Guaranteed interoperability
- Performance and reliability assurance
- Consistent user experience across platforms

## Certification Levels

### Bronze Certification - Basic Compliance

**Requirements**:
- Implement all required protocol endpoints
- Pass automated validation test suite
- Meet minimum performance benchmarks
- Provide basic documentation

**Test Coverage**:
- Core functionality validation
- Error handling verification
- Basic performance testing
- Security baseline checks

### Silver Certification - Production Ready

**Additional Requirements**:
- Advanced performance benchmarks
- Security assessment completion
- Load testing validation
- Comprehensive documentation
- Customer reference implementations

**Test Coverage**:
- Stress testing under load
- Security penetration testing
- Integration with multiple client types
- Edge case handling validation

### Gold Certification - Industry Leader

**Additional Requirements**:
- Innovation features implementation
- Community contribution requirements
- Advanced security certifications
- Uptime and reliability guarantees
- 24/7 support availability

**Test Coverage**:
- Comprehensive feature coverage
- Advanced security audit
- Multi-region deployment testing
- Disaster recovery validation

## Certification Process

### Phase 1: Application Submission

**Required Materials**:
1. **Technical Documentation**
   - Complete API documentation
   - Implementation architecture overview
   - Security and privacy policies
   - Performance characteristics

2. **Self-Assessment**
   - Completed certification checklist
   - Test results from validation suite
   - Security self-assessment report

3. **Implementation Access**
   - Test credentials for certification team
   - Access to staging/testing environment
   - Documentation for testing procedures

### Phase 2: Technical Validation

**Automated Testing** (1-2 weeks):
- Protocol compliance validation
- Performance benchmark testing
- Security baseline scanning
- Integration testing with reference clients

**Manual Review** (2-3 weeks):
- Code quality assessment
- Security architecture review
- Documentation completeness check
- User experience evaluation

### Phase 3: Security Assessment

**Security Requirements**:
- Vulnerability assessment
- Authentication mechanism review
- Data protection verification
- Incident response procedures

**Security Testing**:
- Penetration testing (Silver/Gold only)
- Threat modeling review
- Compliance validation (GDPR, CCPA, etc.)
- Access control verification

### Phase 4: Performance Validation

**Performance Metrics**:
```
Bronze Level:
- Response time: < 2 seconds (95th percentile)
- Throughput: 100 requests/minute minimum
- Uptime: 99% monthly availability

Silver Level:  
- Response time: < 1 second (95th percentile)
- Throughput: 500 requests/minute minimum
- Uptime: 99.5% monthly availability

Gold Level:
- Response time: < 500ms (95th percentile)  
- Throughput: 1000+ requests/minute
- Uptime: 99.9% monthly availability
```

**Load Testing**:
- Sustained load testing (24+ hours)
- Peak load handling capability
- Graceful degradation under stress
- Recovery time after outages

### Phase 5: Final Review

**Certification Committee Review**:
- Technical implementation assessment
- Security posture evaluation
- Documentation quality review
- Overall user experience rating

**Decision Criteria**:
- All automated tests passing
- Security requirements met
- Performance benchmarks achieved
- Documentation standards satisfied

## Certification Maintenance

### Annual Recertification

**Requirements**:
- Updated test suite execution
- Security reassessment
- Performance validation
- Documentation updates

**Process**:
- Streamlined testing for existing certified platforms
- Focus on new features and protocol updates
- Validation of continued compliance
- Review of any reported issues

### Continuous Monitoring

**Ongoing Requirements**:
- Incident reporting within 48 hours
- Quarterly performance reporting
- Annual security assessments
- Participation in interoperability testing

**Monitoring Metrics**:
- Service availability and performance
- User satisfaction feedback
- Security incident tracking
- Protocol compliance drift

## Certification Testing

### Validation Test Suite

**Installation**:
```bash
npm install -g @adcontextprotocol/certification-suite
```

**Basic Testing**:
```bash
# Run full certification test suite
acp-certify --endpoint https://api.yourplatform.com \
           --credentials ./test-credentials.json \
           --level bronze

# Run specific test categories
acp-certify --tests security,performance \
           --endpoint https://api.yourplatform.com
```

**Test Categories**:
- **Protocol Compliance**: All endpoints and response formats
- **Error Handling**: Proper error responses and codes
- **Security**: Authentication, authorization, input validation
- **Performance**: Response times, throughput, reliability
- **Integration**: Cross-platform compatibility testing

### Custom Testing

**Platform-Specific Tests**:
Platforms may need additional testing for:
- Unique features beyond standard protocol
- Integration with existing platform capabilities
- Custom authentication mechanisms
- Specialized audience types or data sources

## Certification Costs

### Pricing Structure

**Bronze Certification**:
- Application fee: $5,000
- Annual maintenance: $2,500
- Re-certification: $2,500

**Silver Certification**:
- Application fee: $15,000
- Annual maintenance: $7,500
- Re-certification: $5,000

**Gold Certification**:
- Application fee: $30,000
- Annual maintenance: $15,000
- Re-certification: $10,000

**Enterprise Packages**:
- Multi-platform discounts available
- Custom certification tracks for large implementations
- Dedicated certification manager assignment

### Payment Terms

- 50% due upon application acceptance
- 50% due upon successful certification
- Annual maintenance fees due yearly from certification date
- Re-certification fees due upon renewal

## Application Process

### Getting Started

1. **Review Requirements**: Ensure your implementation meets minimum standards
2. **Complete Self-Assessment**: Use the certification checklist
3. **Prepare Documentation**: Gather all required materials
4. **Submit Application**: Online application with required materials
5. **Schedule Kickoff**: Initial meeting with certification team

### Timeline

**Typical Certification Timeline**:
- Application review: 1 week
- Technical validation: 2-4 weeks
- Security assessment: 1-3 weeks
- Performance testing: 1-2 weeks
- Final review: 1 week
- **Total**: 6-11 weeks depending on level

### Contact Information

**Certification Team**: certification@adcontextprotocol.org

**Application Portal**: [https://certification.adcontextprotocol.org](https://certification.adcontextprotocol.org)

**Support**: For technical questions during certification process

## Certified Platforms

### Current Certified Platforms



### Certification Status Verification

Verify a platform's certification status:
- **Badge Verification**: Look for official ACP certification badges
- **Platform Directory**: Check the certified platforms list
- **API Verification**: Query certification status API

Ready to get certified? Start your application today! 🏆