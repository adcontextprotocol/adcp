---
title: Principals & Security
---

# Principals & Security

A critical concept in AdCP is the **Principal**. A Principal represents a distinct client or buyer. The protocol is designed to be multi-tenant, and security is enforced through bearer token authentication.

## Authentication

All MCP requests must be authenticated using a bearer token. The client must include an `x-adcp-auth` header with each request:

`x-adcp-auth: <your_secret_token>`

The server validates this token and associates it with both a specific `tenant_id` and `principal_id`. All subsequent operations within that request are scoped to that authenticated tenant and principal.

### The Principal Model

On the server, a Principal is defined by:
- **`principal_id`** (string): A unique identifier for the client (e.g., `"purina"`).
- **`platform_mappings`** (dict): A JSON object that maps the `principal_id` to identifiers in various ad serving platforms (e.g., `{"gam_advertiser_id": 12345}`).

## Data Isolation

Authentication provides the foundation for strict data isolation. The server **MUST** enforce the following rules:

1.  When an object like a `MediaBuy` is created, it **MUST** be permanently associated with the `principal_id` from the authenticated request context.
2.  For any subsequent request to read or modify that object, the server **MUST** verify that the `principal_id` from the new request's context matches the `principal_id` stored with the object.
3.  If the IDs do not match, the server **MUST** return a permission denied error.

This model ensures that one principal can never view or modify another principal's data, as they will not possess the correct bearer token to do so. Passing a `principal_id` in the request body is not required or respected; the identity is based solely on the validated token.

## Multi-Tenant Architecture

AdCP supports full multi-tenant deployment, allowing a single instance to serve multiple publishers:

### Tenant Model

Each tenant represents a publisher with:
- **`tenant_id`**: Unique identifier for the publisher
- **`subdomain`**: Optional subdomain for routing (e.g., `sports.example.com`)
- **`config`**: JSON configuration including adapter settings, features, and limits
- **`admin_token`**: Special token for administrative operations

### Tenant Isolation

1. **Data Isolation**: All data (principals, products, media buys, creatives) is scoped by `tenant_id`
2. **Configuration Isolation**: Each tenant has independent adapter configuration
3. **Token Namespace**: Authentication tokens are unique within each tenant

### Admin Operations

Some tools are restricted to admin users with the tenant's admin token:
- `review_pending_creatives`: Approve/reject creative submissions
- `list_human_tasks`: View manual approval queue
- `complete_human_task`: Process manual approvals
- `get_all_media_buy_delivery`: View all media buys across principals

## Security Boundaries

### Adapter Security

Each ad server adapter enforces its own security perimeter:
- **Read vs Write**: Some adapters may have read-only access
- **Scope Limitations**: Access may be limited to specific accounts/networks
- **API Quotas**: Platform-specific rate limits and quotas

### Audit Logging

All operations are logged with:
- Timestamp
- Principal and tenant context
- Operation type and parameters
- Success/failure status
- Security-relevant events (auth failures, permission denials)
