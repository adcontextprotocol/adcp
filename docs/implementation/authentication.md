---
sidebar_position: 2
title: Authentication
---

# Authentication Patterns

Authentication in ACP determines account permissions, available audiences, and pricing rates.

## Account Types

### Platform Accounts
Represent advertising platforms that aggregate multiple customers:

```json
{
  "account_type": "platform",
  "platform_name": "scope3",
  "permissions": ["syndicate", "aggregate_usage"],
  "customer_accounts": ["nike", "adidas", "puma"]
}
```

### Customer Accounts  
Represent direct advertiser or agency relationships:

```json
{
  "account_type": "customer", 
  "customer_name": "nike",
  "permissions": ["activate", "report_usage"],
  "seats": ["nike_us_001", "nike_emea_002"]
}
```

## Authentication Flow

### 1. MCP Session Authentication

```typescript
server.setAuthHandler(async (credentials) => {
  // Validate API key or token
  const account = await validateCredentials(credentials.token);
  
  if (!account) {
    throw new Error('Invalid credentials');
  }
  
  return {
    accountId: account.id,
    accountType: account.type,
    permissions: account.permissions,
    availablePlatforms: account.platforms
  };
});
```

### 2. Request-Level Authorization

Each tool call should verify permissions:

```typescript
async function activateAudienceHandler(params: any, context: AuthContext) {
  const { segment_id, platform, seat } = params;
  
  // Check if account can activate on this platform
  if (!context.permissions.includes('activate')) {
    throw new Error('ACTIVATION_UNAUTHORIZED');
  }
  
  // Check if account has access to this seat
  if (context.accountType === 'customer' && !context.seats.includes(seat)) {
    throw new Error('SEAT_UNAUTHORIZED');
  }
  
  // Proceed with activation
  return await activateAudience(segment_id, platform, seat);
}
```

## Credential Types

### API Keys

Simple authentication for stable integrations:

```typescript
interface ApiKeyAuth {
  type: 'api_key';
  key: string;
  secret?: string;
}

// Usage
const credentials = {
  type: 'api_key',
  key: 'ak_live_1234567890abcdef',
  secret: 'sk_live_0987654321fedcba'
};
```

### OAuth 2.0

For user-delegated access:

```typescript
interface OAuthAuth {
  type: 'oauth';
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
}

// Usage  
const credentials = {
  type: 'oauth',
  access_token: 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9...',
  refresh_token: 'rt_1234567890abcdef',
  expires_at: 1642694400
};
```

### JWT Tokens

For service-to-service authentication:

```typescript
interface JWTAuth {
  type: 'jwt';
  token: string;
}

// Usage
const credentials = {
  type: 'jwt', 
  token: 'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9...'
};
```

## Permission Models

### Role-Based Access

Define permissions by role:

```typescript
enum Role {
  VIEWER = 'viewer',          // Read-only access
  OPERATOR = 'operator',      // Activate + report
  ADMIN = 'admin',           // Full access
  PLATFORM = 'platform'      // Platform-level access
}

const rolePermissions = {
  [Role.VIEWER]: ['get_audiences', 'check_audience_status'],
  [Role.OPERATOR]: ['get_audiences', 'activate_audience', 'check_audience_status', 'report_usage'],
  [Role.ADMIN]: ['*'],
  [Role.PLATFORM]: ['*', 'syndicate', 'aggregate_usage']
};
```

### Resource-Based Access

Granular permissions by resource:

```typescript
interface Permissions {
  audiences: {
    discover: boolean;
    activate: boolean;
    deactivate: boolean;
  };
  platforms: string[];  // Which platforms can be accessed
  seats: string[];      // Which seats can be used
  usage: {
    report: boolean;
    view: boolean;
  };
}
```

## Implementation Examples

### Scope3 Authentication

```typescript
class Scope3AuthHandler {
  async authenticate(credentials: any): Promise<AuthContext> {
    const response = await fetch('https://api.scope3.com/auth/validate', {
      headers: {
        'Authorization': `Bearer ${credentials.token}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error('Invalid Scope3 credentials');
    }
    
    const account = await response.json();
    
    return {
      accountId: account.id,
      accountType: account.type,
      permissions: account.permissions,
      platforms: ['scope3'],
      seats: account.seats || []
    };
  }
}
```

### LiveRamp Authentication

```typescript
class LiveRampAuthHandler {
  async authenticate(credentials: any): Promise<AuthContext> {
    // LiveRamp uses OAuth 2.0
    const tokenInfo = await this.validateOAuthToken(credentials.access_token);
    
    return {
      accountId: tokenInfo.sub,
      accountType: tokenInfo.account_type,
      permissions: tokenInfo.scope.split(' '),
      platforms: tokenInfo.platforms,
      seats: tokenInfo.seats
    };
  }
  
  private async validateOAuthToken(token: string) {
    const response = await fetch('https://api.liveramp.com/oauth/tokeninfo', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    return await response.json();
  }
}
```

## Security Best Practices

### Token Management

- **Rotate credentials** regularly
- **Use short-lived tokens** when possible
- **Store securely** (never in logs or client-side code)
- **Validate expiration** before each request

### Request Validation

```typescript
function validateRequest(params: any, context: AuthContext) {
  // Validate required fields
  if (!params.segment_id) {
    throw new Error('MISSING_SEGMENT_ID');
  }
  
  // Check authorization
  if (!context.permissions.includes('activate_audience')) {
    throw new Error('INSUFFICIENT_PERMISSIONS');
  }
  
  // Validate platform access
  if (!context.platforms.includes(params.platform)) {
    throw new Error('PLATFORM_UNAUTHORIZED');
  }
  
  // Additional validation logic...
}
```

### Audit Logging

Track all authentication and authorization events:

```typescript
interface AuditEvent {
  timestamp: Date;
  accountId: string;
  action: string;
  resource: string;
  success: boolean;
  ipAddress: string;
  userAgent: string;
}

function logAuditEvent(event: AuditEvent) {
  // Log to your audit system
  console.log(JSON.stringify(event));
}
```

## Error Handling

### Authentication Errors

```typescript
enum AuthError {
  INVALID_CREDENTIALS = 'INVALID_CREDENTIALS',
  TOKEN_EXPIRED = 'TOKEN_EXPIRED', 
  INSUFFICIENT_PERMISSIONS = 'INSUFFICIENT_PERMISSIONS',
  PLATFORM_UNAUTHORIZED = 'PLATFORM_UNAUTHORIZED',
  SEAT_UNAUTHORIZED = 'SEAT_UNAUTHORIZED'
}

function handleAuthError(error: AuthError, context?: any) {
  return {
    success: false,
    error: {
      code: error,
      message: getErrorMessage(error),
      details: context
    }
  };
}
```

### Token Refresh

Handle expired tokens gracefully:

```typescript
async function refreshTokenIfNeeded(credentials: OAuthAuth): Promise<OAuthAuth> {
  if (credentials.expires_at && Date.now() > credentials.expires_at * 1000) {
    const refreshed = await refreshOAuthToken(credentials.refresh_token);
    return {
      ...credentials,
      access_token: refreshed.access_token,
      expires_at: refreshed.expires_at
    };
  }
  
  return credentials;
}
```

## Testing Authentication

### Unit Tests

```typescript
describe('Authentication', () => {
  test('should validate valid API key', async () => {
    const credentials = { type: 'api_key', key: 'valid_key' };
    const context = await authHandler.authenticate(credentials);
    
    expect(context.accountType).toBe('customer');
    expect(context.permissions).toContain('activate_audience');
  });
  
  test('should reject invalid credentials', async () => {
    const credentials = { type: 'api_key', key: 'invalid_key' };
    
    await expect(authHandler.authenticate(credentials))
      .rejects.toThrow('Invalid credentials');
  });
});
```

### Integration Tests

```typescript
describe('Authorization', () => {
  test('should allow customer to activate own seats', async () => {
    const context = { accountType: 'customer', seats: ['nike_us_001'] };
    const params = { segment_id: 'seg_123', platform: 'scope3', seat: 'nike_us_001' };
    
    expect(() => validateAuthorization(params, context)).not.toThrow();
  });
  
  test('should prevent customer from using other seats', async () => {
    const context = { accountType: 'customer', seats: ['nike_us_001'] };
    const params = { segment_id: 'seg_123', platform: 'scope3', seat: 'adidas_us_001' };
    
    expect(() => validateAuthorization(params, context))
      .toThrow('SEAT_UNAUTHORIZED');
  });
});
```

## Next Steps

- [Implement Best Practices](./best-practices)
- [Set Up Testing](./testing)
- [Review Security Guidelines](../reference/security)