# AdCP Agent Discovery Protocol

The AdCP Agent Discovery Protocol enables orchestrators to automatically discover MCP endpoints for advertising agents.

## Overview

The discovery protocol uses the `.well-known` URI pattern (RFC 8615) to provide a standardized location for AdCP agent endpoints at:

```
https://example.com/.well-known/adcp.json
```

## Discovery Document Format

The discovery document is a simple JSON object mapping agent types to their MCP endpoints:

```json
{
  "sales": "https://salesagent.example.com/mcp",
  "signals": "https://signals.example.com/mcp",
  "curation": "https://curation.example.com/mcp"
}
```

That's it. No complex configuration needed.

## Agent Types

- **sales**: Media buying and inventory management
- **signals**: Analytics and performance data
- **curation**: Content and audience curation

## Examples

### Scope3 Signals Agent

```json
{
  "signals": "https://signals.scope3.com/mcp"
}
```

### Publisher with Multiple Agents

```json
{
  "sales": "https://api.publisher.com/adcp/sales/mcp",
  "signals": "https://api.publisher.com/adcp/analytics/mcp"
}
```

### Full-Service Platform

```json
{
  "sales": "https://platform.example.com/mcp/sales",
  "curation": "https://platform.example.com/mcp/curation",
  "signals": "https://platform.example.com/mcp/signals"
}
```

## Implementation Requirements

### For Publishers

1. Create a JSON file with your agent endpoints
2. Serve it at `/.well-known/adcp.json` with `Content-Type: application/json`
3. Use HTTPS with valid certificates
4. Add CORS headers for browser-based orchestrators:
   ```
   Access-Control-Allow-Origin: *
   Access-Control-Allow-Methods: GET
   ```

### For Orchestrators

1. GET the discovery document from `/.well-known/adcp.json`
2. Parse the JSON to find agent endpoints
3. Connect to the MCP endpoints directly
4. Handle authentication as specified by the MCP protocol

## MCP Connection

Once you have the MCP endpoint from discovery, connect using the standard MCP protocol. The MCP server will provide:

- Available tools and capabilities
- Authentication requirements
- Protocol version information
- Any other metadata needed

## Why So Simple?

- **Publishers** only need to maintain a static JSON file
- **No duplication** - capabilities and auth are handled by MCP
- **Always current** - no risk of discovery data being out of sync
- **Easy to implement** - can be a static file on any web server

## Security Considerations

- Always use HTTPS for both discovery and MCP endpoints
- Validate SSL certificates
- The discovery document is public - don't include secrets
- Authentication happens at the MCP layer, not discovery

## Quick Implementation

### Static File (Nginx)

```nginx
location = /.well-known/adcp.json {
    add_header Content-Type application/json;
    add_header Access-Control-Allow-Origin *;
    return 200 '{"sales": "https://api.example.com/mcp"}';
}
```

### Express.js

```javascript
app.get('/.well-known/adcp.json', (req, res) => {
  res.json({
    sales: "https://api.example.com/sales/mcp",
    signals: "https://api.example.com/signals/mcp"
  });
});
```

### Static File

Just create a file at `/.well-known/adcp.json` on your web server:

```json
{
  "sales": "https://salesagent.mycompany.com/mcp"
}
```

## Testing

```bash
# Discover agents
curl https://example.com/.well-known/adcp.json

# Response
{
  "sales": "https://api.example.com/mcp"
}

# Connect to the MCP endpoint directly for full capabilities
```