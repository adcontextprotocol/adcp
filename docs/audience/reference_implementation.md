## Reference javascript implementation for ACP Audience Agent
The objective of the reference implementation is to show a developer (or coding agent) how to set up an Audience Agent and make it easy to replace the default flat-file implementation with a database or other connection. The reference implementation should be easy to run locallly or in a public cloud, ideally with a few clicks. 

### Tech stack
Let's use Node.js as our tech stack.
To make OAuth easy to integrate with multiple providers, let's use mcp-auth (https://mcp-auth.dev/docs/tutorials/whoami).
We can use MCPInspector to make sure our audience agent works!

### Authorization
The agent should use OAuth with a config file that provides a map of account_id to email domain. Any email domain that isn't mapped to an account_id should be treated as a default catalog user.

### Error Handling for OAuth

The implementation should gracefully handle OAuth failures with clear error messages and fallback behaviors:

**Common OAuth Error Scenarios**
```javascript
// OAuth error handler
async function handleOAuthError(error, context) {
  switch (error.code) {
    case 'invalid_token':
      // Token expired or revoked
      return {
        error: 'Authentication expired',
        action: 'refresh_token',
        fallback: 'use_default_catalog'
      };
    
    case 'insufficient_scope':
      // User lacks required permissions
      return {
        error: 'Insufficient permissions',
        required_scope: 'audience:read',
        fallback: 'use_default_catalog'
      };
    
    case 'network_error':
      // OAuth provider unreachable
      return {
        error: 'Authentication service unavailable',
        retry_after: 30,
        fallback: 'use_cached_auth'
      };
    
    default:
      // Unknown errors default to safe mode
      return {
        error: 'Authentication failed',
        fallback: 'use_default_catalog'
      };
  }
}
```

**Fallback Strategy**
- If OAuth fails, fall back to default catalog access
- Cache successful authentications for 1 hour
- Log all auth failures for debugging (without exposing tokens)
- Provide clear error messages to help users resolve auth issues

### Data catalog
The data catalog is provided in CSV, including granular data that can be used for custom audiences. For instance:

audience_id, name, description
1234, Book lovers, People who have read book review articles
1234-271, Sunday book review - June 2025, People who read the Sunday book review in the month of June 2025
8281, Adtechy, Special people who like adtech

Catalogs are created using a CSV as well, with the default catalog specific with a blank account_id or 'default'

account_id, audience_id, currency, cpm, pct_of_media
default, 1234, GBP, 1.00, 10
custom_catalog, 1234, GBP, 0.80, 8
custom_catalog, 8281, GBP, 2.00, 15

For the purposes of the reference implementation, let's find or create a dataset that will be interesting to demonstrate the capabilities.

### Example CSV Datasets

Here are example CSV files for testing the implementation:

**audiences.csv**
```csv
audience_id,name,description
1234,Book lovers,People who have read book review articles
1234-271,Sunday book review - June 2025,People who read the Sunday book review in the month of June 2025
1234-272,Fiction enthusiasts,Readers who prefer fiction book reviews
1234-273,Business book readers,Readers interested in business and finance books
8281,Adtechy,Special people who like adtech
8282,MarTech enthusiasts,Marketing technology professionals and enthusiasts
9001,Travel readers,People interested in travel and adventure content
9001-101,Europe travel 2025,Readers planning European trips in 2025
9002,Food & dining,Culinary enthusiasts and restaurant reviewers
```

**catalogs.csv**
```csv
account_id,audience_id,currency,cpm,pct_of_media
default,1234,GBP,1.00,10
default,8281,GBP,2.00,15
default,9001,GBP,1.50,12
default,9002,GBP,1.20,8
custom_catalog,1234,GBP,0.80,8
custom_catalog,1234-271,GBP,0.90,5
custom_catalog,8281,GBP,1.80,12
premium_catalog,1234,USD,3.00,20
premium_catalog,8282,USD,4.50,25
premium_catalog,9001,USD,2.50,15
```

### Protocol
When get_audiences is called, the agent should send the data catalog as context to a model and returns a list of possible audiences, including a few custom audiences that meet the audience spec. Custom audiences should be priced randomly in a range specified in a config file.

When activate_audience is called, this should hit a stub implementation of "provision audience" that could be swapped for a decisioning platform API. It would be good to provide modules for decisioning platforms here. Same for check_audience_status and report_usage - these should hit stubs.

### AI Model Integration

The `get_audiences` function requires an AI model to analyze the audience specification and generate relevant matches. The implementation should support swappable AI providers through a simple interface:

**Model Interface**
```javascript
class AIProvider {
  async generateAudiences(audienceSpec, catalogData) {
    // Returns array of audience suggestions
  }
}
```

**Default Implementation (OpenAI)**
```javascript
// config.json
{
  "ai_provider": "openai",
  "ai_config": {
    "model": "gpt-4o-mini",
    "api_key_env": "OPENAI_API_KEY",
    "temperature": 0.7,
    "max_tokens": 1000
  },
  "custom_audience_pricing": {
    "min_cpm": 0.50,
    "max_cpm": 5.00,
    "default_currency": "GBP"
  }
}
```

**Swappable Providers**
The implementation should include adapters for common providers:
- OpenAI (default)
- Anthropic Claude
- Local LLMs via Ollama
- Custom HTTP endpoint

Each provider adapter should handle:
- Formatting the catalog data as context
- Parsing the audience specification
- Returning structured audience recommendations with pricing

### Modules
We should build a Scope3 decisioning platform module that implements the Scope3 audience API as a reference implementation for others that want to implement this.

All of these are relative to https://api.scope3.com/v1 (but that should be configurable). To provision "segment1" for a UK postal code identifier:

POST /segment/segment1
```json
{
	"key": "uk_postal_code",
	"region": "eu",
	"name": "Segment Uno"
}
```

This call requires a SCOPE3_API_KEY that should be set up as a secret or environment variable.

To populate the segment, data can be uploaded to a cloud bucket or sent to a real-time API:

POST https://api.scope3.com/audience/uk_postal_code
ADD W3C121 segment1
ADD SW12A81 segment1, segment2  # Can update multiple identifiers at once
REM SW11F12 segment1            # Removes segment1 from this identifier
SET NW382A segment1, segment3   # Overwrites all segments for this identifier