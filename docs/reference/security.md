---
sidebar_position: 4
title: Security
---

# Security Guidelines

Security best practices for implementing and using the Ad Context Protocol.

## Authentication Security

### Credential Management

**API Key Security**:
- Use long, randomly generated API keys (minimum 32 characters)
- Rotate credentials regularly (every 90 days recommended)
- Never log or expose credentials in client-side code
- Store credentials securely using environment variables or key management systems

**OAuth 2.0 Best Practices**:
- Use short-lived access tokens (15-60 minutes)
- Implement proper token refresh flows
- Validate token scopes match required permissions
- Use PKCE for public clients

### Transport Security

**HTTPS Requirements**:
- All ACP communications must use HTTPS with TLS 1.2 or higher
- Validate SSL certificates and use certificate pinning where possible
- Implement proper HSTS headers
- Use secure cipher suites only

## Data Protection

### Signal Data

**Data Minimization**:
- Only request signal data necessary for the specific use case
- Avoid storing signal metadata longer than required
- Implement data retention policies aligned with business needs

**PII Protection**:
- ACP protocols do not expose personally identifiable information
- Signal descriptions should use aggregate, non-identifying language
- Platform providers must ensure underlying data complies with privacy regulations

### Usage Reporting

**Data Integrity**:
- Validate all usage data before transmission
- Use checksums or digital signatures for critical reporting data
- Implement audit logs for all usage reporting activities
- Detect and prevent duplicate reporting

## Authorization

### Account Permissions

**Principle of Least Privilege**:
- Grant only the minimum permissions required for each account
- Regularly audit account permissions and remove unused access
- Implement role-based access controls (RBAC)
- Use separate credentials for different environments (dev/staging/prod)

**Platform/Seat Authorization**:
- Validate platform access before processing requests
- Ensure seat-level permissions are enforced consistently
- Log all authorization decisions for audit purposes
- Implement rate limiting per account and permission level

## Input Validation

### Request Validation

**Parameter Sanitization**:
```typescript
// Example: Sanitize signal_spec input
function sanitizeSignalSpec(spec: string): string {
  return spec
    .replace(/[<>]/g, '') // Remove potential HTML
    .replace(/['"]/g, '') // Remove quotes
    .slice(0, 1000);      // Limit length
}

// Validate deliver_to object
function validateDeliverTo(deliverTo: any): boolean {
  if (!deliverTo || typeof deliverTo !== 'object') return false;
  
  if (deliverTo.platform && typeof deliverTo.platform !== 'string') return false;
  if (deliverTo.seat && typeof deliverTo.seat !== 'string') return false;
  if (deliverTo.countries && !Array.isArray(deliverTo.countries)) return false;
  
  return true;
}
```

**SQL Injection Prevention**:
- Use parameterized queries for all database operations
- Validate and sanitize all input parameters
- Implement input length limits
- Use allow-lists for enum values (platforms, countries, etc.)

## Rate Limiting

### DDoS Protection

**Implementation Strategies**:
- Implement rate limiting per account, IP, and endpoint
- Use exponential backoff for failed requests
- Monitor for unusual traffic patterns
- Implement circuit breakers for external dependencies

**Rate Limit Guidelines**:
```typescript
const rateLimits = {
  get_signals: 100,     // requests per minute
  activate_signal: 10,   // requests per minute  
  check_signal_status: 200, // requests per minute
  report_usage: 50        // requests per minute
};
```

## Logging and Monitoring

### Security Logging

**Required Log Events**:
- All authentication attempts (success and failure)
- Authorization decisions and permission changes
- Signal activation and deactivation events
- Usage reporting submissions
- Error conditions and exceptions

**Log Data Protection**:
- Never log sensitive data (credentials, PII)
- Use structured logging for consistent parsing
- Implement log rotation and retention policies
- Ensure log integrity and tamper detection

### Monitoring and Alerting

**Security Metrics**:
- Failed authentication rates
- Unusual usage patterns
- Geographic anomalies in access patterns
- Rate limit violations
- Data validation failures

## Incident Response

### Security Incident Management

**Incident Response Plan**:
1. **Detection**: Automated monitoring and alerting
2. **Assessment**: Determine scope and severity
3. **Containment**: Isolate affected systems
4. **Communication**: Notify stakeholders as required
5. **Recovery**: Restore normal operations
6. **Lessons Learned**: Document and improve processes

**Communication Protocols**:
- Maintain updated contact information for security incidents
- Establish escalation procedures for different severity levels
- Coordinate with platform partners during multi-platform incidents

## Compliance

### Regulatory Requirements

**Privacy Regulations**:
- GDPR compliance for EU data subjects
- CCPA compliance for California residents
- Industry-specific regulations (COPPA, HIPAA, etc.)
- Data localization requirements by jurisdiction

**Industry Standards**:
- SOC 2 Type II compliance recommended for platform providers
- Regular security assessments and penetration testing
- Vulnerability management and patch deployment procedures

## Implementation Checklist

### For Platform Providers

- [ ] Implement proper authentication and authorization
- [ ] Use HTTPS for all communications
- [ ] Validate and sanitize all inputs
- [ ] Implement comprehensive logging
- [ ] Set up monitoring and alerting
- [ ] Conduct regular security assessments
- [ ] Maintain incident response procedures
- [ ] Document security controls and procedures

### For Platform Users

- [ ] Secure credential storage and rotation
- [ ] Monitor usage patterns for anomalies
- [ ] Implement proper error handling
- [ ] Validate responses from ACP endpoints
- [ ] Maintain audit logs of ACP interactions
- [ ] Keep client libraries and dependencies updated

## Reporting Security Issues

### Responsible Disclosure

**Security Contact**: security@adcontextprotocol.org

**Reporting Guidelines**:
- Provide detailed description of the vulnerability
- Include steps to reproduce the issue
- Specify affected protocol versions
- Allow reasonable time for response (90 days standard)

**Response Process**:
1. **Acknowledgment**: Within 48 hours
2. **Initial Assessment**: Within 1 week  
3. **Resolution Timeline**: Communicated based on severity
4. **Public Disclosure**: Coordinated after resolution

## Additional Resources

- [OWASP API Security Top 10](https://owasp.org/www-project-api-security/)
- [OAuth 2.0 Security Best Practices](https://tools.ietf.org/html/draft-ietf-oauth-security-topics)
- [NIST Cybersecurity Framework](https://www.nist.gov/cyberframework)

Stay secure and protect your implementations! 🔒