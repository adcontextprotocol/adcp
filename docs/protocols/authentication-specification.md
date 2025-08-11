---
sidebar_position: 7
title: Authentication
---

# Authentication Specification

AdCP supports multiple authentication methods for secure access to the protocol.

## Authentication Methods

### JWT Bearer Token
```http
Authorization: Bearer <jwt_token>
```

JWT tokens must include standard claims:
```json
{
  "sub": "principal_123",
  "exp": 1706745600,
  "iat": 1706742000,
  "permissions": {
    "products": ["read"],
    "media_buys": ["read", "write"],
    "creatives": ["read", "write"],
    "reports": ["read"]
  }
}
```

### API Key
```http
X-API-Key: <api_key>
```

API keys are mapped to principals and their associated permissions.

## Principal Model

```typescript
interface Principal {
  principal_id: string;
  permissions: {
    products: Permission[];
    media_buys: Permission[];
    creatives: Permission[];
    reports: Permission[];
  };
}

type Permission = 'read' | 'write' | 'delete' | 'approve';
```

## Required Headers by Protocol

### MCP
```json
{
  "headers": {
    "Authorization": "Bearer <token>"
  }
}
```

### A2A
```json
{
  "headers": {
    "Authorization": "Bearer <token>"
  }
}
```

### HTTP REST
```http
Authorization: Bearer <token>
# OR
X-API-Key: <api_key>
```