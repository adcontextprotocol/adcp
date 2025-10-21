# Security Policy

## Overview

The Advertising Context Protocol (AdCP) is designed to facilitate programmatic advertising transactions between AI agents and publishers. Given that AdCP handles financial commitments, potentially sensitive campaign data, and first-party audience signals, security is a critical concern for all implementations.

This document outlines security considerations, vulnerability disclosure procedures, and best practices for implementing and deploying AdCP-compliant systems.

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 2.x     | :white_check_mark: |
| < 2.0   | :x:                |

## Reporting a Vulnerability

We take security vulnerabilities seriously. If you discover a security issue in:

- **The AdCP specification** (protocol design flaws, auth model issues, etc.)
- **Reference implementations** (code in this repository)
- **Documentation** (insecure guidance or missing security considerations)

Please report it responsibly:

### Reporting Process

1. **DO NOT** open a public GitHub issue for security vulnerabilities
2. Email security reports to: **[security contact needed]**
3. Include in your report:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact assessment
   - Affected versions/components
   - Suggested remediation (if available)

### What to Expect

- **Initial Response**: Within 72 hours
- **Vulnerability Assessment**: Within 1 week
- **Fix Timeline**: Depends on severity (critical issues prioritized)
- **Disclosure**: Coordinated disclosure after fix is available
- **Credit**: Public acknowledgment (unless you prefer anonymity)

### Severity Guidelines

- **Critical**: Remote code execution, authentication bypass, budget manipulation
- **High**: Authorization flaws, data exposure, financial transaction integrity issues
- **Medium**: Information disclosure, denial of service, encryption weaknesses
- **Low**: Security best practice violations, documentation gaps

## Security Considerations for Implementers

### Authentication & Authorization

AdCP does not prescribe a specific authentication mechanism, but implementers MUST:

1. **Authenticate All API Requests**
   - Use industry-standard protocols (OAuth 2.0, API keys with HMAC signatures, mutual TLS)
   - Never rely on client-provided identity claims without verification
   - Implement proper credential rotation procedures

2. **Implement Authorization Controls**
   - Separate read and write permissions
   - Scope credentials to specific capabilities (e.g., `read:products` vs `create:media_buy`)
   - Enforce principal-specific access controls (agent A cannot modify agent B's campaigns)

3. **Secure Async Operations**
   - Validate webhook signatures using HMAC or similar cryptographic verification
   - Use short-lived, cryptographically random task IDs and context IDs
   - Implement webhook endpoint authentication
   - Consider webhook payload encryption for sensitive data

### Financial Transaction Safety

AdCP implementations handling real advertising budgets MUST implement:

1. **Idempotency**
   - Support idempotency keys on all state-changing operations (`create_media_buy`, `update_media_buy`)
   - Prevent duplicate charges from retries or network issues
   - Maintain idempotency key history for appropriate retention period

2. **Budget Controls**
   - Validate budget values against account limits before processing
   - Implement spending caps and alert mechanisms
   - Provide audit trails for all budget commitments
   - Support budget approval workflows for high-value transactions

3. **Transaction Integrity**
   - Use database transactions to ensure atomic updates
   - Implement reconciliation processes to detect discrepancies
   - Log all financial operations immutably
   - Provide mechanisms for dispute resolution

4. **Fraud Prevention**
   - Monitor for suspicious patterns (unusual spending, rapid campaign creation)
   - Implement rate limiting on budget-impacting operations
   - Require additional verification for high-value or high-risk transactions
   - Maintain blocklists for compromised credentials

### Data Protection

1. **Encryption**
   - Use TLS 1.3+ for all data in transit
   - Encrypt sensitive data at rest (PII in signals, financial information, creative assets)
   - Use envelope encryption for bulk data storage
   - Implement proper key management (rotate keys, use KMS services)

2. **First-Party Signals**
   - Treat audience signals as potentially containing PII
   - Implement data minimization (collect only necessary signals)
   - Respect data retention policies and user deletion requests
   - Provide mechanisms for data subject access requests (GDPR/CCPA)

3. **Creative Assets**
   - Implement access controls on creative storage (pre-launch campaigns may be confidential)
   - Sanitize user-provided creative content to prevent XSS or malicious payloads
   - Validate file types and scan for malware
   - Enforce size limits to prevent resource exhaustion

4. **Targeting Briefs**
   - Treat briefs as potentially containing competitive intelligence
   - Implement appropriate access controls
   - Consider brief anonymization for compliance workflows
   - Log access to sensitive targeting information

### Operational Security

1. **Rate Limiting**
   - Implement per-credential and per-IP rate limits
   - Apply stricter limits on expensive operations (`create_media_buy`, `build_creative`)
   - Use exponential backoff for repeated failures
   - Provide clear rate limit headers in responses

2. **Logging & Monitoring**
   - Log all authentication attempts (success and failure)
   - Log all state-changing operations with actor identity
   - Monitor for anomalous patterns (unusual spending, access patterns)
   - Implement alerting for security-relevant events
   - Retain logs for appropriate compliance period (90+ days recommended)

3. **API Security Best Practices**
   - Validate all input rigorously (reject unknown fields, enforce type safety)
   - Use parameterized queries to prevent injection attacks
   - Implement CORS policies appropriately for web-based agents
   - Set appropriate security headers (CSP, HSTS, X-Frame-Options)
   - Never expose internal error details in API responses

4. **Dependency Management**
   - Keep all dependencies up to date with security patches
   - Use automated vulnerability scanning (Dependabot, Snyk, etc.)
   - Pin dependency versions and audit changes
   - Minimize dependency surface area

### Multi-Party Trust Model

AdCP's three-role model (Principal, Publisher, Orchestrator) introduces unique security considerations:

1. **Principal-Publisher Trust**
   - Publishers must authenticate principals requesting capability information
   - Principals should verify publisher identity before committing budgets
   - Consider reputation systems or trusted registries

2. **Orchestrator Security**
   - Orchestrators handle credentials for multiple parties - implement strict isolation
   - Use least-privilege principles (scoped credentials per party)
   - Audit orchestrator access patterns
   - Consider multi-party authorization for high-value operations

3. **Data Isolation**
   - Campaign data must be isolated between principals
   - Creative assets must not be accessible cross-principal
   - Signals must be scoped to appropriate audiences
   - Implement row-level security in multi-tenant databases

## Compliance Considerations

AdCP implementations may need to comply with various regulations depending on jurisdiction and data handling:

- **GDPR** (EU): First-party signals may constitute personal data
- **CCPA** (California): Consumer privacy rights for audience targeting
- **SOC 2**: For service providers handling advertising transactions
- **PCI DSS**: If handling payment card information (less common in programmatic)
- **Industry Self-Regulation**: IAB standards, NAI Code of Conduct, DAA principles

Consult with legal counsel to understand your specific compliance obligations.

## Security Checklist for Implementers

Before deploying an AdCP implementation to production:

- [ ] Authentication mechanism implemented and tested
- [ ] Authorization model enforces least-privilege access
- [ ] TLS 1.3+ configured for all endpoints
- [ ] Sensitive data encrypted at rest
- [ ] Idempotency implemented for state-changing operations
- [ ] Budget validation and spending limits enforced
- [ ] Rate limiting configured appropriately
- [ ] Security logging and monitoring in place
- [ ] Incident response procedures documented
- [ ] Webhook signatures verified cryptographically
- [ ] Input validation prevents injection attacks
- [ ] Dependencies scanned for known vulnerabilities
- [ ] Security testing performed (penetration testing recommended)
- [ ] Privacy policy and terms of service reviewed by legal
- [ ] Data retention and deletion procedures implemented

## Security Resources

- **OWASP API Security Top 10**: https://owasp.org/www-project-api-security/
- **OAuth 2.0 Security Best Practices**: https://datatracker.ietf.org/doc/html/draft-ietf-oauth-security-topics
- **NIST Cryptographic Standards**: https://csrc.nist.gov/projects/cryptographic-standards-and-guidelines
- **Cloud Security Alliance**: https://cloudsecurityalliance.org/

## Questions or Concerns

If you have security questions that are not sensitive vulnerability reports:

- Open a GitHub Discussion in the Security category
- Email the working group: **[working group contact needed]**
- Join the AdCP Slack workspace: https://join.slack.com/t/agenticads/shared_invite/zt-3c5sxvdjk-x0rVmLB3OFHVUp~WutVWZg

## Updates to This Policy

This security policy will be updated as the protocol evolves. Significant changes will be announced through:

- GitHub security advisories
- Working group communications
- Release notes

Last updated: 2025-10-21
