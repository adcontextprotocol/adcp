---
sidebar_position: 7
title: Authentication
---

# Authentication Specification

AdCP supports multiple authentication methods with consistent principal identification across protocols.

## Authentication Methods

### JWT Bearer Token
```http
Authorization: Bearer <jwt_token>
```

JWT tokens must include AdCP claims:
```json
{
  "sub": "principal_123",
  "adcp": {
    "principal_type": "advertiser",
    "tenant_id": "tenant_abc",
    "permissions": {
      "products": ["read"],
      "media_buys": ["read", "write"]
    }
  }
}
```

### API Key
```http
X-API-Key: <api_key>
```

API keys are mapped to principals server-side.

## Tenant Identification

Multi-tenant systems resolve tenant in priority order:

1. **Header**: `X-Tenant-ID: <tenant_id>`
2. **JWT Claim**: `adcp.tenant_id`
3. **Subdomain**: `<tenant>.adcp.com`
4. **Default**: Single-tenant mode

## Principal Model

```typescript
interface Principal {
  principal_id: string;
  principal_type: 'user' | 'service' | 'agency' | 'advertiser';
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
    "Authorization": "Bearer <token>",
    "X-Tenant-ID": "<tenant_id>"  // Optional
  }
}
```

### HTTP REST
```http
Authorization: Bearer <token>
X-Tenant-ID: <tenant_id>  // Optional
```