# 6. Principals & Security

A critical concept in AdCP is the **Principal**. A Principal represents a distinct client or buyer. The protocol is designed to be multi-tenant, and security is enforced through bearer token authentication.

## Authentication

All API requests must be authenticated using a bearer token. The client must include an `Authorization` header with each request:

`Authorization: Bearer <your_secret_token>`

The server is responsible for validating this token and associating it with a specific `principal_id`. All subsequent operations within that request are scoped to that authenticated principal.

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
