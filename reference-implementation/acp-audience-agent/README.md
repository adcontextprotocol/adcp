# ACP Audience Agent Reference Implementation

This is a reference implementation of an Audience Agent for the Ad Context Protocol (ACP) using the Model Context Protocol (MCP).

## Features

- CSV-based audience and catalog management
- OAuth authentication with account mapping
- Swappable AI providers (OpenAI, Anthropic, Stub)
- Audience discovery based on specifications
- Stub implementations for audience activation, status checking, and usage reporting

## Quick Start

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Set up environment variables:**
   ```bash
   cp .env.example .env
   # Edit .env with your API keys
   ```

3. **Configure the agent:**
   Edit `config/config.json` to:
   - Choose your AI provider
   - Set account mappings
   - Configure pricing ranges

4. **Run the MCP server:**
   ```bash
   npm start
   ```

5. **Test with MCP Inspector:**
   ```bash
   npx @modelcontextprotocol/inspector
   ```
   Then connect to the server using the command provided.

## Project Structure

```
acp-audience-agent/
├── src/
│   ├── index.js           # Main MCP server
│   ├── dataLoader.js      # CSV data loading
│   ├── ai/                # AI provider implementations
│   │   ├── aiProvider.js
│   │   ├── openaiProvider.js
│   │   └── anthropicProvider.js
│   └── auth/              # OAuth handling
│       └── authManager.js
├── data/                  # CSV data files
│   ├── audiences.csv
│   └── catalogs.csv
├── config/
│   └── config.json        # Configuration
└── package.json
```

## Available Tools

### get_audiences
Discover audiences based on specifications:
```json
{
  "audience_spec": {
    "keywords": ["travel", "europe"],
    "max_results": 10
  },
  "include_custom": true
}
```

### activate_audience
Activate an audience on a decisioning platform (stub):
```json
{
  "account_id": "custom_catalog",
  "audience_id": "9001",
  "decisioning_platform": "scope3"
}
```

### check_audience_status
Check activation status (stub):
```json
{
  "account_id": "custom_catalog",
  "audience_id": "9001",
  "activation_id": "act_123456"
}
```

### report_usage
Report usage metrics (stub):
```json
{
  "account_id": "custom_catalog",
  "audience_id": "9001",
  "activation_id": "act_123456",
  "usage_data": {
    "impressions": 10000,
    "clicks": 150,
    "spend": 25.50,
    "currency": "GBP"
  }
}
```

## Customization

### Adding New AI Providers

1. Create a new provider class in `src/ai/`
2. Extend the `AIProvider` base class
3. Implement the `generateAudiences` method
4. Add to the factory in `aiProvider.js`

### Integrating Real Decisioning Platforms

Replace the stub implementations in `src/index.js` with actual API calls to your decisioning platform.

## License

MIT