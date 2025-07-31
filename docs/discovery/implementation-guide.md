# Discovery Protocol Implementation Guide

This guide helps publishers implement the AdCP Discovery Protocol.

## Quick Start

1. Create a JSON file mapping agent types to MCP endpoints
2. Serve it at `https://yourdomain.com/.well-known/adcp.json`
3. That's it!

## Example Discovery Document

```json
{
  "sales": "https://salesagent.yourdomain.com/mcp"
}
```

## Implementation Options

### Option 1: Static File

Create a file named `adcp.json` in your `.well-known` directory:

```json
{
  "sales": "https://api.yourdomain.com/sales/mcp",
  "signals": "https://api.yourdomain.com/analytics/mcp"
}
```

### Option 2: Nginx Configuration

```nginx
location = /.well-known/adcp.json {
    add_header Content-Type application/json;
    add_header Access-Control-Allow-Origin *;
    return 200 '{"sales": "https://salesagent.example.com/mcp"}';
}
```

### Option 3: Dynamic Response

```javascript
// Express.js
app.get('/.well-known/adcp.json', (req, res) => {
  res.json({
    sales: "https://api.example.com/sales/mcp"
  });
});
```

## Requirements

- **HTTPS**: Both discovery and MCP endpoints must use HTTPS
- **Content-Type**: Must be `application/json`
- **CORS**: Add headers for browser-based access:
  ```
  Access-Control-Allow-Origin: *
  Access-Control-Allow-Methods: GET
  ```

## Testing Your Implementation

```bash
# Test discovery
curl https://yourdomain.com/.well-known/adcp.json

# Expected response
{
  "sales": "https://api.yourdomain.com/mcp"
}
```

## Common Issues

### 404 Not Found
- Check the path is exactly `/.well-known/adcp.json`
- Ensure your web server serves the file

### CORS Errors
- Add the required CORS headers
- Test from a browser console

### Invalid JSON
- Validate your JSON syntax
- Use double quotes for strings

## Examples

### Single Agent
```json
{
  "signals": "https://signals.scope3.com/mcp"
}
```

### Multiple Agents
```json
{
  "sales": "https://api.example.com/sales/mcp",
  "curation": "https://api.example.com/curation/mcp",
  "signals": "https://api.example.com/signals/mcp"
}
```

## Next Steps

Once your discovery endpoint is working:

1. Implement your MCP server at the specified endpoint
2. Handle MCP authentication and capabilities
3. Test with an AdCP orchestrator

For help with MCP implementation, see the [MCP documentation](https://modelcontextprotocol.io).