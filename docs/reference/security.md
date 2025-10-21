---
sidebar_position: 4
title: Security
---

# Security Guidelines

Security best practices for implementing and using the Ad Context Protocol.

:::danger Critical for Production Use
AdCP handles financial commitments and potentially sensitive campaign data. Implementations managing real advertising budgets MUST implement the security controls outlined in this document.
:::

## Overview

AdCP operates in a high-stakes environment where:
- **Financial transactions** involve real advertising spend
- **Multi-party trust** requires coordination between Principals, Publishers, and Orchestrators
- **Sensitive data** includes first-party signals, pre-launch creatives, and competitive targeting strategies
- **Asynchronous operations** span multiple systems and protocols

This document provides security requirements and best practices for AdCP implementations.

## Authentication & Authorization

AdCP does not mandate a specific authentication mechanism, allowing implementers to choose appropriate protocols for their use case. However, production implementations MUST enforce strong authentication and authorization.

### Authentication Mechanisms

**Recommended Approaches**:
- **OAuth 2.0**: Industry standard, supports scoped permissions and delegation
- **API Keys with HMAC**: Simple, appropriate for server-to-server communication
- **Mutual TLS (mTLS)**: Strong cryptographic authentication for high-security environments
- **JWT Tokens**: Stateless authentication with embedded claims

**Implementation Requirements**:
```typescript
// Example: OAuth 2.0 token validation
interface AuthConfig {
  tokenEndpoint: string;
  requiredScopes: string[];
  allowedIssuers: string[];
}

async function validateToken(token: string, config: AuthConfig): Promise<boolean> {
  // Verify token signature
  // Check expiration
  // Validate required scopes
  // Confirm issuer is trusted
  return true; // or throw authentication error
}
```

**Security Standards**:
- Use cryptographically strong authentication mechanisms (minimum 128-bit security)
- Never transmit credentials in URL parameters (use headers or request bodies)
- Implement proper credential rotation procedures
- Support credential revocation and audit logging

### Authorization Model

**Scoped Permissions**:

AdCP implementations should implement fine-grained authorization:

| Scope | Description | Example Operations |
|-------|-------------|-------------------|
| `read:products` | Discover available inventory | `get_products`, `list_creative_formats` |
| `read:campaigns` | View campaign details | `list_creatives`, `get_media_buy_delivery` |
| `write:campaigns` | Create and modify campaigns | `create_media_buy`, `update_media_buy` |
| `write:creatives` | Upload and manage creatives | `sync_creatives` |
| `read:signals` | Access audience signals | `get_signals` (if signals module implemented) |
| `admin:*` | Full administrative access | All operations |

**Principal Isolation**:
- Each Principal MUST have separate credentials
- Principal A cannot access or modify Principal B's campaigns
- Orchestrators managing multiple principals MUST enforce strict isolation
- Implement row-level security in multi-tenant deployments

**Publisher Verification**:
- Principals should verify publisher identity before committing budgets
- Use trusted publisher registries or reputation systems when available
- Log all publisher interactions for audit purposes

### Credential Management

**Storage Best Practices**:
- Use secure key management systems (AWS KMS, Azure Key Vault, HashiCorp Vault)
- Never commit credentials to version control
- Use environment variables or secret managers for deployment
- Encrypt credentials at rest

**Rotation Procedures**:
- Rotate credentials every 90 days minimum
- Support graceful rotation (allow old and new credentials during transition)
- Revoke compromised credentials immediately
- Maintain audit log of all credential changes

**For Orchestrators**:
```typescript
// Example: Secure credential storage for multi-principal orchestrator
interface PrincipalCredentials {
  principalId: string;
  encryptedApiKey: string; // Encrypted at rest
  scopes: string[];
  expiresAt: Date;
  rotationScheduled: Date;
}

class CredentialManager {
  async getCredentials(principalId: string): Promise<string> {
    // Retrieve encrypted credentials
    // Decrypt using KMS
    // Check expiration
    // Return plaintext for use (never log!)
  }
}
```

### Transport Security

**HTTPS Requirements**:
- All AdCP communications MUST use HTTPS with TLS 1.3+ (TLS 1.2 minimum)
- Validate SSL certificates (no self-signed certificates in production)
- Implement HTTP Strict Transport Security (HSTS) headers
- Use secure cipher suites only (disable TLS 1.0/1.1)

**Webhook Security**:
```typescript
// Example: HMAC signature verification for async callbacks
function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  const hmac = crypto.createHmac('sha256', secret);
  const expectedSignature = hmac.update(payload).digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}
```

**Webhook Best Practices**:
- Always verify HMAC signatures on webhook payloads
- Use HTTPS for all webhook endpoints
- Implement webhook authentication (bearer tokens or mTLS)
- Use short-lived, cryptographically random task IDs and context IDs
- Consider webhook payload encryption for sensitive data

## Financial Transaction Safety

AdCP's `create_media_buy` and `update_media_buy` tasks commit real advertising budgets. Implementations MUST implement controls to prevent financial loss from bugs, attacks, or operational errors.

### Idempotency

**Critical Requirement**: All state-changing operations MUST support idempotency to prevent duplicate charges.

```typescript
// Example: Idempotent media buy creation
interface CreateMediaBuyRequest {
  idempotency_key: string; // Client-provided, unique per operation
  budget: {
    amount: number;
    currency: string;
  };
  // ... other parameters
}

class MediaBuyService {
  async createMediaBuy(request: CreateMediaBuyRequest): Promise<MediaBuy> {
    // Check if this idempotency key was already processed
    const existing = await this.findByIdempotencyKey(request.idempotency_key);
    if (existing) {
      // Return existing result, don't charge again
      return existing;
    }

    // Process new request
    // Store idempotency key with result
    // Return new media buy
  }
}
```

**Implementation Guidelines**:
- Accept client-provided idempotency keys (UUIDs recommended)
- Store idempotency keys with operation results for minimum 24 hours
- Return identical response for duplicate requests within retention window
- Use atomic database transactions to prevent race conditions

### Budget Validation

**Pre-Flight Checks**:
```typescript
interface BudgetValidation {
  requestedBudget: Money;
  accountBalance: Money;
  existingCommitments: Money;
  dailySpendLimit: Money;
  monthlySpendLimit: Money;
}

async function validateBudget(validation: BudgetValidation): Promise<void> {
  const availableBalance = validation.accountBalance - validation.existingCommitments;

  if (validation.requestedBudget > availableBalance) {
    throw new InsufficientFundsError("Budget exceeds available balance");
  }

  if (validation.requestedBudget > validation.dailySpendLimit) {
    throw new BudgetLimitError("Exceeds daily spend limit");
  }

  // Additional checks...
}
```

**Required Controls**:
- Validate budget values are positive, non-zero amounts
- Check currency codes are valid ISO 4217 codes
- Enforce account-level spending limits
- Prevent budget increases beyond configured thresholds without additional approval
- Validate budget is within product minimum/maximum if specified

### Approval Workflows

**High-Value Transaction Approval**:
```typescript
interface ApprovalPolicy {
  requiresApprovalThreshold: Money;
  approvers: string[]; // User IDs or roles
  timeoutDuration: number; // milliseconds
}

async function requiresApproval(
  budget: Money,
  policy: ApprovalPolicy
): Promise<boolean> {
  return budget.amount >= policy.requiresApprovalThreshold.amount;
}
```

**Implementation Patterns**:
- Define approval thresholds per principal or account
- Support multi-step approval for high-value campaigns
- Implement approval timeouts (auto-reject after N hours)
- Provide audit trail of approval decisions
- Support emergency override procedures with enhanced logging

### Transaction Integrity

**Atomic Operations**:
```typescript
// Example: Atomic budget commitment
async function commitBudget(mediaBuy: MediaBuy): Promise<void> {
  await db.transaction(async (tx) => {
    // 1. Check account balance
    const account = await tx.accounts.findOne({ id: mediaBuy.principalId }, { lock: true });

    // 2. Validate sufficient funds
    if (account.balance < mediaBuy.budget.amount) {
      throw new InsufficientFundsError();
    }

    // 3. Create media buy record
    await tx.mediaBuys.insert(mediaBuy);

    // 4. Deduct from account balance
    await tx.accounts.update(
      { id: mediaBuy.principalId },
      { balance: account.balance - mediaBuy.budget.amount }
    );

    // 5. Create audit log entry
    await tx.auditLog.insert({
      type: 'budget_commitment',
      principalId: mediaBuy.principalId,
      amount: mediaBuy.budget.amount,
      timestamp: new Date()
    });
  });
}
```

**Best Practices**:
- Use database transactions for multi-step financial operations
- Implement retry logic with exponential backoff for transient failures
- Log all financial operations immutably (append-only audit log)
- Implement reconciliation processes to detect discrepancies
- Support refunds and budget adjustments with full audit trail

### Fraud Prevention

**Anomaly Detection**:
```typescript
interface FraudDetectionRules {
  maxDailyBudget: Money;
  maxCampaignsPerDay: number;
  unusualSpendingMultiplier: number; // e.g., 5x average
  geoBlacklist: string[]; // Country codes
}

async function detectFraud(
  principal: Principal,
  request: CreateMediaBuyRequest,
  rules: FraudDetectionRules
): Promise<FraudAlert[]> {
  const alerts: FraudAlert[] = [];

  // Check for unusual spending patterns
  const recentSpend = await getRecentSpend(principal.id, 7); // 7 days
  const avgDailySpend = recentSpend / 7;
  if (request.budget.amount > avgDailySpend * rules.unusualSpendingMultiplier) {
    alerts.push({
      severity: 'high',
      reason: 'Unusual spending spike detected',
      recommendation: 'Require additional verification'
    });
  }

  // Check campaign creation velocity
  const todaysCampaigns = await getTodaysCampaignCount(principal.id);
  if (todaysCampaigns >= rules.maxCampaignsPerDay) {
    alerts.push({
      severity: 'medium',
      reason: 'High campaign creation velocity',
      recommendation: 'Rate limit or require approval'
    });
  }

  return alerts;
}
```

**Fraud Prevention Measures**:
- Monitor for suspicious spending patterns (sudden spikes, unusual geos)
- Implement velocity checks (campaigns per day, budget increase rate)
- Maintain blocklists for compromised credentials
- Use IP reputation services to detect bot traffic
- Implement device fingerprinting for high-risk operations
- Support fraud analyst review queues for flagged transactions

### Reconciliation & Audit

**Daily Reconciliation**:
```typescript
interface ReconciliationReport {
  date: Date;
  expectedCommitments: Money;
  actualCommitments: Money;
  discrepancies: Discrepancy[];
  reconciliationStatus: 'clean' | 'discrepancies_found';
}

async function dailyReconciliation(): Promise<ReconciliationReport> {
  // Compare sum of all media buy budgets vs. sum of budget deductions
  // Identify any mismatches
  // Generate report for review
  // Alert on discrepancies above threshold
}
```

**Audit Requirements**:
- Log all budget commitments, modifications, and refunds
- Maintain immutable audit trail (append-only, tamper-evident)
- Implement daily reconciliation processes
- Support audit export for compliance purposes
- Retain financial audit logs for minimum 7 years (or per regulatory requirements)

## Data Protection

### Creative Assets

**Access Control**:
- Implement strict access controls on creative storage
- Pre-launch campaigns may contain confidential or competitive information
- Use signed URLs with expiration for creative preview links
- Prevent unauthorized access through URL guessing (use UUIDs or signed tokens)

**Content Security**:
```typescript
// Example: Validate uploaded creative assets
async function validateCreative(file: UploadedFile): Promise<void> {
  // Check file type
  const allowedTypes = ['image/jpeg', 'image/png', 'video/mp4', 'text/html'];
  if (!allowedTypes.includes(file.mimeType)) {
    throw new InvalidFileTypeError();
  }

  // Check file size
  const maxSize = 100 * 1024 * 1024; // 100MB
  if (file.size > maxSize) {
    throw new FileTooLargeError();
  }

  // Scan for malware
  await malwareScanner.scan(file);

  // For HTML creatives, sanitize to prevent XSS
  if (file.mimeType === 'text/html') {
    file.content = sanitizeHtml(file.content);
  }
}
```

**Security Measures**:
- Validate file types and sizes
- Scan uploaded files for malware
- Sanitize HTML creatives to prevent XSS attacks
- Use content delivery networks (CDNs) with DDoS protection
- Implement rate limiting on creative uploads
- Watermark or fingerprint creatives to detect leaks

### First-Party Signals

**PII Protection**:
- First-party signals MAY contain personally identifiable information
- Implementations MUST comply with GDPR, CCPA, and other privacy regulations
- Signal descriptions should use aggregate, non-identifying language
- Implement data minimization (collect only necessary signals)

**Data Handling Requirements**:
```typescript
interface SignalPrivacyControls {
  dataRetentionDays: number;
  requiresUserConsent: boolean;
  piiDetectionEnabled: boolean;
  anonymizationRequired: boolean;
}

async function processSignal(
  signal: Signal,
  controls: SignalPrivacyControls
): Promise<void> {
  // Detect PII in signal metadata
  if (controls.piiDetectionEnabled) {
    const containsPII = await detectPII(signal.description);
    if (containsPII) {
      throw new PIIDetectedError("Signal metadata contains PII");
    }
  }

  // Check user consent
  if (controls.requiresUserConsent) {
    const hasConsent = await verifyConsent(signal.audienceId);
    if (!hasConsent) {
      throw new ConsentError("User consent required for signal usage");
    }
  }

  // Set expiration based on retention policy
  signal.expiresAt = addDays(new Date(), controls.dataRetentionDays);
}
```

**Privacy Best Practices**:
- Encrypt signals at rest and in transit
- Implement data retention policies (auto-delete after N days)
- Support data subject access requests (GDPR Article 15)
- Support right to deletion (GDPR Article 17)
- Provide transparency about data usage in privacy policies
- Obtain proper user consent before collecting/using signals

### Targeting Briefs

**Competitive Intelligence Protection**:
- Targeting briefs may reveal competitive strategy
- Implement appropriate access controls (principal isolation)
- Log all access to targeting briefs for audit purposes
- Consider brief anonymization for compliance review workflows
- Prevent brief content from appearing in error messages or logs

**Data Security**:
- Encrypt briefs at rest
- Implement access logging and monitoring
- Support time-limited access (briefs expire after campaign completion)
- Provide secure deletion procedures

## Multi-Party Trust Model

AdCP's three-role architecture (Principal, Publisher, Orchestrator) introduces unique security considerations beyond typical client-server APIs.

### Principal-Publisher Trust

**Publisher Identity Verification**:
```typescript
interface PublisherVerification {
  publisherId: string;
  domainOwnership: boolean; // Verified via DNS TXT record or .well-known
  businessVerification: boolean; // D-U-N-S, business license, etc.
  reputationScore: number;
  lastAuditDate: Date;
}

async function verifyPublisher(publisherId: string): Promise<PublisherVerification> {
  // Check publisher registry or reputation system
  // Verify domain ownership
  // Check for fraud reports or complaints
  // Return verification status
}
```

**Trust Establishment**:
- Principals should verify publisher identity before committing budgets
- Use trusted publisher registries (e.g., IAB Tech Lab Ads.txt/Sellers.json)
- Implement publisher reputation scoring
- Support allowlists/blocklists at principal level
- Log all publisher interactions for dispute resolution

**Budget Protection**:
- Start with small test campaigns before large commitments
- Monitor delivery quality and fraud indicators
- Implement automated pause if fraud detected
- Support refund/chargeback mechanisms for non-delivery

### Orchestrator Security

Orchestrators manage credentials and operations for multiple principals, requiring enhanced security controls.

**Credential Isolation**:
```typescript
class SecureOrchestrator {
  private credentialVault: KeyManagementService;

  async executeForPrincipal(
    principalId: string,
    task: AdCPTask
  ): Promise<TaskResult> {
    // Retrieve principal-specific credentials (encrypted at rest)
    const credentials = await this.credentialVault.getCredentials(principalId);

    // Execute task with principal's credentials, not orchestrator's
    const result = await adcpClient.execute(task, credentials);

    // Never log credentials or sensitive details
    this.auditLog.record({
      principalId,
      taskType: task.type,
      timestamp: new Date(),
      success: result.success
      // NO credentials, NO PII, NO competitive intel
    });

    return result;
  }
}
```

**Required Controls**:
- Store each principal's credentials separately (encrypted at rest)
- Use least-privilege credentials (scoped to necessary operations only)
- Implement strict data isolation (Principal A cannot access Principal B's data)
- Log all operations with principal identity
- Support per-principal rate limiting
- Implement audit trails for compliance

**Multi-Tenancy Security**:
- Use row-level security in databases
- Implement principal_id filtering in all queries
- Prevent cross-principal data leakage in error messages
- Separate compute resources per principal (or use sandboxing)
- Monitor for privilege escalation attempts

### Data Isolation Requirements

**Campaign Data Isolation**:
```typescript
// Example: Query with mandatory principal isolation
async function getMediaBuy(
  mediaBuyId: string,
  principalId: string // Always required, never optional
): Promise<MediaBuy> {
  // ALWAYS filter by principal_id - never query without it
  const mediaBuy = await db.mediaBuys.findOne({
    id: mediaBuyId,
    principal_id: principalId // ← Critical: prevents cross-principal access
  });

  if (!mediaBuy) {
    // Generic error - don't reveal if campaign exists for another principal
    throw new NotFoundError("Media buy not found");
  }

  return mediaBuy;
}
```

**Isolation Boundaries**:
- Media buy records MUST be scoped to principal
- Creative assets MUST be scoped to principal
- Targeting briefs MUST be scoped to principal
- Delivery reports MUST be scoped to principal
- Signals MUST be scoped to appropriate audience (never cross-principal)

**Testing Isolation**:
```typescript
// Security test: Ensure cross-principal access is blocked
describe('Principal Isolation', () => {
  it('prevents Principal A from accessing Principal B data', async () => {
    const principalA = 'principal_a';
    const principalB = 'principal_b';

    // Create media buy for Principal B
    const mediaBuy = await createMediaBuy({ principalId: principalB });

    // Attempt to access with Principal A credentials
    await expect(
      getMediaBuy(mediaBuy.id, principalA)
    ).rejects.toThrow(NotFoundError);

    // Generic error - no information leakage
  });
});

## Input Validation & API Security

### Request Validation

All user-provided input MUST be validated before processing to prevent injection attacks, resource exhaustion, and data corruption.

**Type Validation**:
```typescript
// Use JSON Schema or TypeScript validation libraries
import { z } from 'zod';

const CreateMediaBuySchema = z.object({
  product_id: z.string().uuid(),
  targeting_brief: z.string().min(10).max(5000),
  budget: z.object({
    amount: z.number().positive().max(10000000), // $10M max
    currency: z.enum(['USD', 'EUR', 'GBP', 'JPY']) // Allow-list currencies
  }),
  flight_dates: z.object({
    start_date: z.string().datetime(),
    end_date: z.string().datetime()
  }),
  creative_id: z.string().uuid().optional()
});

async function createMediaBuy(request: unknown): Promise<MediaBuy> {
  // Validate and parse - throws if invalid
  const validated = CreateMediaBuySchema.parse(request);

  // Additional business logic validation
  if (validated.flight_dates.end_date <= validated.flight_dates.start_date) {
    throw new ValidationError("End date must be after start date");
  }

  // Process validated request
}
```

**Injection Prevention**:
- Use parameterized queries for all database operations (NEVER string concatenation)
- Sanitize HTML creatives to prevent XSS
- Validate URLs in webhook configurations
- Use allow-lists for enum values (product IDs, currencies, format IDs)
- Reject requests with unexpected fields (strict schema validation)

**Resource Limits**:
```typescript
const INPUT_LIMITS = {
  targeting_brief_max_length: 5000,
  creative_upload_max_size: 100 * 1024 * 1024, // 100MB
  max_formats_per_request: 50,
  max_products_per_query: 100,
  max_date_range_days: 365
};
```

### API Security Best Practices

**CORS Configuration**:
```typescript
// Only for browser-based agents (not server-to-server)
app.use(cors({
  origin: (origin, callback) => {
    const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [];
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  maxAge: 86400 // 24 hours
}));
```

**Security Headers**:
```typescript
app.use((req, res, next) => {
  // Prevent clickjacking
  res.setHeader('X-Frame-Options', 'DENY');

  // Prevent MIME sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Enable browser XSS protection
  res.setHeader('X-XSS-Protection', '1; mode=block');

  // HSTS for HTTPS enforcement
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

  // Content Security Policy
  res.setHeader('Content-Security-Policy', "default-src 'self'");

  next();
});
```

**Error Handling**:
```typescript
// NEVER expose internal details in error responses
app.use((err, req, res, next) => {
  // Log full error internally
  logger.error('Request failed', {
    error: err.message,
    stack: err.stack,
    requestId: req.id,
    principalId: req.auth?.principalId
  });

  // Return generic error to client (no stack traces, no internal paths)
  res.status(err.statusCode || 500).json({
    error: {
      code: err.code || 'internal_error',
      message: err.message || 'An internal error occurred',
      // NO: stack traces, file paths, database errors, internal IDs
    }
  });
});
```

## Rate Limiting & DDoS Protection

### Rate Limiting Strategy

Implement multi-tiered rate limiting to prevent abuse while allowing legitimate usage.

**Per-Endpoint Limits**:
```typescript
const RATE_LIMITS = {
  // Discovery tasks (read-only, cacheable)
  'get_products': { requests: 100, window: '1m' },
  'list_creative_formats': { requests: 100, window: '1m' },
  'list_authorized_properties': { requests: 100, window: '1m' },

  // Campaign management (state-changing, expensive)
  'create_media_buy': { requests: 10, window: '1m' },
  'update_media_buy': { requests: 20, window: '1m' },

  // Creative operations (file uploads, processing)
  'sync_creatives': { requests: 50, window: '1m' },
  'build_creative': { requests: 5, window: '1m' }, // Generative, expensive
  'preview_creative': { requests: 30, window: '1m' },

  // Reporting (database-intensive)
  'get_media_buy_delivery': { requests: 200, window: '1m' },
  'provide_performance_feedback': { requests: 100, window: '1m' },

  // Signals (if implemented)
  'get_signals': { requests: 100, window: '1m' },
  'activate_signal': { requests: 10, window: '1m' }
};
```

**Implementation**:
```typescript
import rateLimit from 'express-rate-limit';

// Per-IP rate limiting (basic DDoS protection)
const ipLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 500, // 500 requests per minute per IP
  message: 'Too many requests from this IP, please try again later'
});

// Per-credential rate limiting (per principal)
const credentialLimiter = (maxRequests: number) => rateLimit({
  windowMs: 60 * 1000,
  max: maxRequests,
  keyGenerator: (req) => req.auth.principalId, // Rate limit by principal
  handler: (req, res) => {
    res.status(429).json({
      error: {
        code: 'rate_limit_exceeded',
        message: `Rate limit exceeded. Max ${maxRequests} requests per minute.`,
        retry_after: Math.ceil(req.rateLimit.resetTime / 1000)
      }
    });
  }
});

// Apply to specific endpoints
app.post('/create_media_buy',
  ipLimiter,
  credentialLimiter(RATE_LIMITS.create_media_buy.requests),
  createMediaBuyHandler
);
```

**Adaptive Rate Limiting**:
```typescript
// Adjust limits based on account tier or reputation
function getRateLimitForPrincipal(principalId: string): number {
  const principal = getPrincipal(principalId);
  const baseLimit = 10;

  // Premium accounts get higher limits
  if (principal.tier === 'enterprise') {
    return baseLimit * 5;
  }

  // New accounts get lower limits until reputation established
  const accountAgeDay s = daysSince(principal.createdAt);
  if (accountAgeDays < 7) {
    return baseLimit * 0.5;
  }

  // Accounts with good reputation get higher limits
  if (principal.reputationScore > 0.9) {
    return baseLimit * 2;
  }

  return baseLimit;
}
```

**Circuit Breaker Pattern**:
```typescript
// Protect downstream services from overload
class CircuitBreaker {
  private failures = 0;
  private lastFailureTime = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      // Check if we should try again
      if (Date.now() - this.lastFailureTime > 60000) {
        this.state = 'half-open';
      } else {
        throw new ServiceUnavailableError('Circuit breaker is open');
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess() {
    this.failures = 0;
    this.state = 'closed';
  }

  private onFailure() {
    this.failures++;
    this.lastFailureTime = Date.now();

    if (this.failures >= 5) {
      this.state = 'open';
    }
  }
}
```

## Logging, Monitoring & Incident Response

### Security Logging

**Required Log Events**:
```typescript
interface SecurityLog {
  timestamp: Date;
  eventType: 'auth' | 'authorization' | 'financial' | 'data_access' | 'error';
  severity: 'info' | 'warning' | 'error' | 'critical';
  principalId?: string;
  ipAddress: string;
  userAgent: string;
  action: string;
  resource?: string;
  outcome: 'success' | 'failure';
  errorCode?: string;
  requestId: string;
  // NEVER: credentials, PII, targeting briefs, internal IDs
}

// Examples
logger.info({
  eventType: 'auth',
  action: 'login_success',
  principalId: 'principal_123',
  ipAddress: '203.0.113.45',
  outcome: 'success'
});

logger.warning({
  eventType: 'financial',
  action: 'budget_limit_approached',
  principalId: 'principal_123',
  resource: 'media_buy_456',
  outcome: 'warning',
  details: { currentSpend: 9500, limit: 10000 }
});

logger.error({
  eventType: 'authorization',
  action: 'cross_principal_access_attempt',
  principalId: 'principal_123',
  resource: 'media_buy_789', // Belongs to principal_456
  outcome: 'failure',
  errorCode: 'unauthorized'
});
```

**Log Categories**:
1. **Authentication Events**: Login attempts, token validation, logout
2. **Authorization Events**: Permission checks, access denials, privilege escalation attempts
3. **Financial Events**: Budget commitments, spending thresholds, fraud alerts
4. **Data Access Events**: Creative downloads, signal access, report generation
5. **Error Events**: Exceptions, validation failures, system errors

**Log Protection**:
```typescript
// Sanitize sensitive data before logging
function sanitizeForLogging(obj: any): any {
  const sanitized = { ...obj };

  // Remove sensitive fields
  const sensitiveFields = [
    'password', 'api_key', 'token', 'secret',
    'credit_card', 'ssn', 'email', 'phone',
    'targeting_brief' // May contain competitive intelligence
  ];

  for (const field of sensitiveFields) {
    if (field in sanitized) {
      sanitized[field] = '[REDACTED]';
    }
  }

  return sanitized;
}
```

**Log Retention**:
- Security logs: 90 days minimum (365 days recommended)
- Financial logs: 7 years (compliance requirement)
- Access logs: 30 days minimum
- Error logs: 90 days

### Monitoring & Alerting

**Critical Alerts** (immediate response required):
```typescript
const CRITICAL_ALERTS = {
  // Authentication
  'multiple_failed_logins': {
    threshold: 10,
    window: '5m',
    action: 'lock_account'
  },

  // Financial
  'unusual_spending_spike': {
    threshold: '5x average',
    window: '1h',
    action: 'require_approval'
  },

  // Security
  'cross_principal_access_attempt': {
    threshold: 1,
    window: '1m',
    action: 'alert_security_team'
  },

  // Availability
  'high_error_rate': {
    threshold: '5%',
    window: '5m',
    action: 'page_oncall'
  }
};
```

**Security Metrics to Monitor**:
```typescript
// Real-time dashboards should track:
const SECURITY_METRICS = {
  // Authentication
  'failed_auth_rate': 'percentage of failed auth attempts',
  'new_principals_per_day': 'account creation velocity',
  'locked_accounts': 'accounts locked due to suspicious activity',

  // Authorization
  'authorization_failures': 'permission denial count',
  'cross_principal_attempts': 'isolation violation attempts',

  // Financial
  'total_budget_committed': 'sum of active campaign budgets',
  'fraud_alerts': 'suspicious transaction count',
  'high_value_transactions': 'transactions above threshold',

  // Operational
  'api_error_rate': 'percentage of failed requests',
  'rate_limit_hits': 'requests blocked by rate limiting',
  'circuit_breaker_trips': 'downstream service failures',

  // Data Access
  'creative_downloads': 'creative asset access count',
  'signal_activations': 'audience signal usage',
  'export_requests': 'data export events'
};
```

**Anomaly Detection**:
```typescript
// Example: Detect unusual geographic access patterns
async function detectGeoAnomaly(principalId: string, ipAddress: string): Promise<boolean> {
  const location = await geolocate(ipAddress);
  const recentLocations = await getRecentLocations(principalId, 30); // Last 30 days

  // Alert if access from new country
  if (!recentLocations.includes(location.country)) {
    logger.warning({
      eventType: 'auth',
      action: 'access_from_new_country',
      principalId,
      details: { country: location.country }
    });

    // Require additional verification
    return true;
  }

  return false;
}
```

### Incident Response

**Incident Response Plan**:

**1. Detection**
- Automated monitoring and alerting
- Manual reports from users or partners
- External security researcher reports

**2. Assessment** (within 1 hour)
- Determine scope and severity
- Identify affected principals and campaigns
- Estimate potential financial impact
- Classify incident (data breach, fraud, availability, etc.)

**3. Containment** (immediate)
```typescript
// Emergency response actions
async function containIncident(incident: SecurityIncident): Promise<void> {
  switch (incident.type) {
    case 'compromised_credentials':
      // Immediately revoke compromised credentials
      await revokeCredentials(incident.principalId);
      // Require password reset
      await requirePasswordReset(incident.principalId);
      // Review recent activity for fraud
      await auditRecentActivity(incident.principalId);
      break;

    case 'budget_fraud':
      // Pause all campaigns for affected principal
      await pauseAllCampaigns(incident.principalId);
      // Prevent new budget commitments
      await lockAccount(incident.principalId);
      // Initiate refund process if applicable
      await initiateRefund(incident.affectedTransactions);
      break;

    case 'data_breach':
      // Identify exposed data
      await identifyExposedData(incident);
      // Notify affected parties
      await notifyAffectedPrincipals(incident);
      // Secure vulnerable systems
      await patchVulnerability(incident.vulnerability);
      break;
  }
}
```

**4. Communication**
- Internal: Notify security team, engineering, management
- External: Notify affected principals within 24 hours
- Regulatory: File required breach notifications (GDPR 72 hours, CCPA 30 days)
- Public: Issue security advisory if widely impacted

**5. Recovery**
- Restore affected systems and data
- Refund fraudulent transactions
- Rebuild customer trust
- Document incident timeline

**6. Post-Incident Review**
- Root cause analysis
- Update security controls
- Improve monitoring and detection
- Train team on lessons learned
- Update incident response procedures

**Communication Templates**:
```typescript
// Principal notification for compromised account
const INCIDENT_NOTIFICATION = {
  subject: 'Security Alert: Account Activity Detected',
  body: `
We detected unusual activity on your AdCP account and have taken
precautionary measures to protect your budget and campaigns.

What happened:
- Multiple failed login attempts from unfamiliar location
- Your credentials may have been compromised

What we've done:
- Temporarily locked your account
- Paused all active campaigns
- Reviewed recent transactions for fraud

What you should do:
1. Reset your password immediately
2. Review recent campaign activity for unauthorized changes
3. Update any shared credentials
4. Enable two-factor authentication

If you have questions or did not recognize this activity, please
contact our security team immediately at security@adcontextprotocol.org

Reference ID: ${incidentId}
  `
};
```

## Compliance & Regulatory Considerations

AdCP implementations may need to comply with various regulations depending on jurisdiction, data handling practices, and business relationships.

### Privacy Regulations

**GDPR (General Data Protection Regulation)**:
- **Scope**: Applies to processing personal data of EU residents
- **AdCP Context**: First-party signals may constitute personal data
- **Requirements**:
  - Lawful basis for processing (consent, legitimate interest, etc.)
  - Data subject rights (access, deletion, portability, rectification)
  - Data protection impact assessments for high-risk processing
  - Data breach notification (72 hours to supervisory authority)
  - Privacy by design and default
- **Documentation**: Maintain records of processing activities

**CCPA (California Consumer Privacy Act)**:
- **Scope**: Applies to California residents' personal information
- **AdCP Context**: Consumer targeting and audience data
- **Requirements**:
  - Consumer rights (know, delete, opt-out, non-discrimination)
  - Notice at collection
  - Privacy policy disclosures
  - Service provider agreements
  - Data breach notification (if unencrypted data exposed)
- **Special Considerations**: "Sale" of personal information requires opt-out

**Other Regulations**:
- **COPPA**: Children's Online Privacy Protection Act (US) - special consent requirements for under-13 audience
- **PIPEDA**: Personal Information Protection and Electronic Documents Act (Canada)
- **Data Localization**: Some jurisdictions require data to be stored within borders (Russia, China, etc.)

### Industry Self-Regulation

**IAB Tech Lab Standards**:
- Ads.txt/App-ads.txt: Publisher authorization verification
- Sellers.json: Supply chain transparency
- TCF (Transparency & Consent Framework): GDPR consent management

**Digital Advertising Alliance (DAA)**:
- Self-regulatory principles for interest-based advertising
- Consumer choice mechanisms (AdChoices icon)
- Enhanced notice requirements

**Network Advertising Initiative (NAI)**:
- Code of Conduct for member companies
- Opt-out mechanisms for interest-based advertising

### Financial & Audit Compliance

**SOC 2 (Service Organization Control 2)**:
- **Recommended for**: Publishers and Orchestrators handling financial transactions
- **Trust Service Criteria**: Security, availability, processing integrity, confidentiality, privacy
- **Type II**: Audits effectiveness of controls over time (6-12 months)

**PCI DSS (Payment Card Industry Data Security Standard)**:
- **Less common** in programmatic advertising (indirect billing more typical)
- **Required if**: Directly processing, storing, or transmitting cardholder data
- **Levels**: Based on transaction volume

**Financial Audit Requirements**:
- Maintain auditable financial records for minimum 7 years
- Support reconciliation and dispute resolution
- Provide transaction-level audit trails

### Security Assessment & Testing

**Recommended Security Assessments**:

| Assessment Type | Frequency | Purpose |
|----------------|-----------|---------|
| Vulnerability Scanning | Weekly | Identify known vulnerabilities in dependencies and infrastructure |
| Penetration Testing | Annually | Simulate real-world attacks to identify exploitable weaknesses |
| Code Security Review | Per major release | Identify security flaws in custom code |
| Third-Party Security Audit | Annually | Independent validation of security controls |
| Compliance Audit (SOC 2) | Annually | Verify compliance with security frameworks |

**Bug Bounty Programs**:
Consider running a bug bounty program to incentivize responsible vulnerability disclosure:
- Define scope (in-scope vs. out-of-scope systems)
- Set bounty amounts based on severity
- Establish clear disclosure guidelines
- Respond promptly to submissions

## Security Implementation Checklist

### For Publishers (AdCP Servers)

**Authentication & Authorization**:
- [ ] Implement strong authentication (OAuth 2.0, API keys, or mTLS)
- [ ] Support scoped permissions (read vs. write operations)
- [ ] Enforce principal isolation in all database queries
- [ ] Log all authentication and authorization events

**Financial Controls**:
- [ ] Implement idempotency for `create_media_buy` and `update_media_buy`
- [ ] Validate budget values and enforce spending limits
- [ ] Support approval workflows for high-value transactions
- [ ] Implement daily reconciliation processes
- [ ] Maintain immutable financial audit logs (7+ years)

**Data Protection**:
- [ ] Use TLS 1.3+ for all communications
- [ ] Encrypt sensitive data at rest (creatives, signals, briefs)
- [ ] Implement access controls on creative storage
- [ ] Sanitize HTML creatives to prevent XSS
- [ ] Verify webhook signatures cryptographically

**Operational Security**:
- [ ] Implement rate limiting per principal and endpoint
- [ ] Validate all input with strict schema validation
- [ ] Use parameterized queries (prevent SQL injection)
- [ ] Set appropriate security headers (HSTS, CSP, X-Frame-Options)
- [ ] Never expose internal details in error messages

**Monitoring & Incident Response**:
- [ ] Implement comprehensive security logging
- [ ] Set up monitoring and alerting for anomalies
- [ ] Develop and document incident response procedures
- [ ] Conduct regular security drills
- [ ] Establish communication channels for security incidents

**Compliance**:
- [ ] Document data processing activities (GDPR Article 30)
- [ ] Implement data subject rights (access, deletion, portability)
- [ ] Establish data retention and deletion policies
- [ ] Conduct DPIAs for high-risk processing
- [ ] Consider SOC 2 audit for enterprise customers

**Testing & Assessment**:
- [ ] Conduct annual penetration testing
- [ ] Implement automated vulnerability scanning
- [ ] Perform security code reviews before releases
- [ ] Test principal isolation with security tests
- [ ] Validate authentication bypass protections

### For Principals (AdCP Clients)

**Credential Security**:
- [ ] Store credentials in secure key management system (not code)
- [ ] Rotate credentials every 90 days
- [ ] Use least-privilege credentials (scoped to necessary operations)
- [ ] Never log or expose credentials
- [ ] Revoke credentials immediately if compromised

**Budget Protection**:
- [ ] Start with small test campaigns with new publishers
- [ ] Monitor spending against budgets in real-time
- [ ] Implement alerts for unusual spending patterns
- [ ] Validate publisher identity before large commitments
- [ ] Maintain allowlists/blocklists for publishers

**Data Security**:
- [ ] Use HTTPS for all AdCP communications
- [ ] Validate responses from publishers (don't trust blindly)
- [ ] Encrypt targeting briefs if containing sensitive strategy
- [ ] Implement access controls for campaign data
- [ ] Log all AdCP interactions for audit purposes

**Operational**:
- [ ] Handle errors gracefully (retry with exponential backoff)
- [ ] Implement circuit breakers for failing publishers
- [ ] Monitor API error rates and latency
- [ ] Keep client libraries and dependencies updated
- [ ] Validate webhook authenticity (if receiving async callbacks)

### For Orchestrators (Multi-Principal Agents)

**Credential Management**:
- [ ] Store each principal's credentials separately (encrypted at rest)
- [ ] Use key management service (AWS KMS, Azure Key Vault, etc.)
- [ ] Never share credentials between principals
- [ ] Implement credential rotation per principal
- [ ] Support credential revocation

**Data Isolation**:
- [ ] Enforce principal_id filtering in ALL queries
- [ ] Use row-level security in databases
- [ ] Prevent cross-principal data leakage in error messages
- [ ] Implement security tests for isolation violations
- [ ] Log all operations with principal identity

**Operational Security**:
- [ ] Implement per-principal rate limiting
- [ ] Support per-principal spending limits and approvals
- [ ] Maintain separate audit logs per principal
- [ ] Sandbox execution environments (optional but recommended)
- [ ] Monitor for privilege escalation attempts

**Compliance**:
- [ ] Act as data processor (not controller) for principals
- [ ] Maintain data processing agreements with principals
- [ ] Support data export and deletion requests
- [ ] Provide transparency about data handling practices
- [ ] Consider SOC 2 audit for enterprise orchestration services

## Vulnerability Disclosure

For vulnerability disclosure policy and reporting procedures, see [SECURITY.md](https://github.com/adcontextprotocol/adcp/blob/main/SECURITY.md) in the AdCP repository.

**Quick Reference**:
- **Report vulnerabilities to**: security@adcontextprotocol.org
- **Expected response time**: Within 72 hours
- **Public disclosure timeline**: After fix is available (coordinated disclosure)

## Security Resources

**Standards & Frameworks**:
- [OWASP API Security Top 10](https://owasp.org/www-project-api-security/)
- [OAuth 2.0 Security Best Practices](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-security-topics)
- [NIST Cybersecurity Framework](https://www.nist.gov/cyberframework)
- [NIST Cryptographic Standards](https://csrc.nist.gov/projects/cryptographic-standards-and-guidelines)
- [Cloud Security Alliance](https://cloudsecurityalliance.org/)

**Industry Resources**:
- [IAB Tech Lab Security](https://iabtechlab.com/standards/security/)
- [Ads.txt Specification](https://iabtechlab.com/ads-txt/)
- [TCF (Transparency & Consent Framework)](https://iabeurope.eu/tcf-2-0/)

**Compliance Guides**:
- [GDPR Official Text](https://gdpr.eu/)
- [CCPA Official Text](https://oag.ca.gov/privacy/ccpa)
- [SOC 2 Overview](https://www.aicpa.org/interestareas/frc/assuranceadvisoryservices/aicpasoc2report.html)

**Tools & Libraries**:
- [OWASP ZAP](https://www.zaproxy.org/) - Security testing tool
- [Snyk](https://snyk.io/) - Dependency vulnerability scanning
- [Dependabot](https://github.com/dependabot) - Automated dependency updates
- [Let's Encrypt](https://letsencrypt.org/) - Free TLS certificates

---

**Remember**: Security is not a one-time implementation but an ongoing process. Regular assessments, updates, and monitoring are essential for maintaining secure AdCP implementations.