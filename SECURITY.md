# Security Policy

The Advertising Context Protocol (AdCP) handles financial commitments and potentially sensitive campaign data. Security is a critical concern for all implementations.

For comprehensive security guidance, see our [Security Documentation](https://docs.adcontextprotocol.org/reference/security).

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
2. Email security reports to: **security@adcontextprotocol.org**
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

## Security Best Practices

For detailed guidance on implementing secure AdCP systems, including:

- **Financial Transaction Safety**: Idempotency, budget controls, fraud prevention
- **Authentication & Authorization**: OAuth 2.0, API keys, scoped permissions, principal isolation
- **Data Protection**: Encryption, PII handling, creative asset security
- **Multi-Party Trust**: Principal/Publisher/Orchestrator security model
- **Operational Security**: Rate limiting, monitoring, incident response
- **Compliance**: GDPR, CCPA, SOC 2, and other regulatory requirements
- **Implementation Checklists**: Role-specific security requirements

See our comprehensive [Security Documentation](https://docs.adcontextprotocol.org/reference/security).

## Security Questions & Discussion

For security questions that are not sensitive vulnerability reports:

- **Documentation**: https://docs.adcontextprotocol.org/reference/security
- **GitHub Discussions**: Security category
- **Email**: security@adcontextprotocol.org
- **Slack**: https://join.slack.com/t/agenticads/shared_invite/zt-3c5sxvdjk-x0rVmLB3OFHVUp~WutVWZg
