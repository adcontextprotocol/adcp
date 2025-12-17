# AdCP - Open Standard for Advertising Automation

**Unified advertising automation protocol built on Model Context Protocol (MCP)**

[![GitHub stars](https://img.shields.io/github/stars/adcontextprotocol/adcp?style=social)](https://github.com/adcontextprotocol/adcp)
[![Documentation](https://img.shields.io/badge/docs-adcontextprotocol.org-blue)](https://adcontextprotocol.org)
[![npm version](https://img.shields.io/npm/v/@adcp/client)](https://www.npmjs.com/package/@adcp/client)
[![MCP Compatible](https://img.shields.io/badge/MCP-compatible-green)](https://modelcontextprotocol.io)

> **AdCP revolutionizes advertising automation by providing a single, AI-powered protocol that works across all major advertising platforms.**

## Documentation

Visit [adcontextprotocol.org](https://adcontextprotocol.org) for full documentation.

## What is AdCP?

Ad Context Protocol (AdCP) is an **open standard for advertising automation** that enables AI assistants to interact with advertising platforms through natural language. Built on the Model Context Protocol (MCP), AdCP provides:

- 🔌 **Unified Advertising API** - Single interface for all advertising platforms
- 🤖 **AI-Powered Automation** - Built for natural language campaign management
- 📊 **Cross-Platform Analytics** - Standardized reporting across all platforms  
- 🔓 **Open Standard** - No vendor lock-in, community-driven development
- ⚡ **Programmatic Ready** - Designed for modern ad tech workflows

### Quick Example

Instead of navigating complex interfaces:

> "Find audience signals of premium sports enthusiasts who would be interested in high-end running shoes, and activate them on Scope3."

The AI assistant handles:
- Signal discovery across platforms
- Transparent pricing comparison  
- Direct activation on decisioning platforms

## Available Protocols

### 🎯 Signals Activation Protocol - RFC/v0.1
Discover and activate data signals using natural language.

- **Natural Language Discovery**: "High-income millennials interested in sustainable fashion" (audience signal)
- **Contextual Signals**: "Premium automotive content with high viewability"
- **Multi-Dimensional**: Combine geographical, temporal, and behavioral signals
- **Multi-Platform Activation**: Deploy across DSPs and data platforms
- **Transparent Pricing**: CPM and revenue share models
- **Real-time Status**: Track activation and deployment progress

### 📍 Curation Protocol - Coming Soon
Curate media inventory based on context and brand safety requirements.

### 💰 Media Buy Protocol - RFC/v0.1  
Execute and optimize media buys programmatically across platforms.

## Quick Start

### Install Client Libraries

#### JavaScript/TypeScript
```bash
npm install @adcp/client
```
- **NPM Package**: [@adcp/client](https://www.npmjs.com/package/@adcp/client)
- **GitHub**: [adcp-client](https://github.com/adcontextprotocol/adcp-client)

#### Python
```bash
pip install adcp
```
- **PyPI Package**: [adcp](https://pypi.org/project/adcp/)
- **GitHub**: [adcp-python](https://github.com/adcontextprotocol/adcp-python)

### For Platform Providers

Implement AdCP to enable AI-powered workflows for your customers:

1. **Review the Specification**: [Signals Protocol](https://adcontextprotocol.org/docs/signals/specification)
2. **Implement MCP Server**: Check out the [reference implementations](#reference-implementations)
3. **Test Your Implementation**: Use the validation test suite

### For Advertisers & Agencies

Use AdCP-enabled platforms with your AI assistant:

1. **Check Platform Support**: See which platforms support AdCP
2. **Configure Your AI**: Connect AdCP-enabled platforms to Claude, GPT, or other assistants
3. **Start Using**: Describe your marketing objectives in natural language

## Repository Structure

```
adcontextprotocol/
├── mintlify-docs/          # Mintlify documentation (docs.adcontextprotocol.org)
│   ├── docs/              # Protocol documentation
│   │   ├── signals/       # Signals protocol
│   │   ├── media-buy/     # Media Buy protocol
│   │   └── creatives/     # Creative protocol
├── server/                # Express server
│   ├── src/              # TypeScript server code
│   └── public/           # Static HTML pages (homepage, registry UI)
├── static/               # Static assets
│   └── schemas/          # JSON schemas
├── registry/             # Agent registry
│   ├── creative/         # Creative agents
│   ├── media-buy/        # Media buy agents
│   └── signals/          # Signal agents
└── README.md            # This file
```

## Community

### Working Group

Join our working group to help shape the future of advertising protocols:

- **Monthly Meetings**: First Wednesday of each month
- **GitHub Discussions**: [Join the conversation](https://github.com/adcontextprotocol/adcp/discussions)
- **Mailing List**: announcements@adcontextprotocol.org

### Contributing

We welcome contributions from:

- **Platform Providers**: Implement and improve protocols
- **Agencies & Advertisers**: Share use cases and feedback
- **Developers**: Contribute code, documentation, and examples
- **Industry Experts**: Help define standards and best practices

See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

## Reference Implementations

- [Signals Agent](https://github.com/adcontextprotocol/signals-agent)
- [Sales Agent](https://github.com/adcontextprotocol/salesagent)

## Platform Implementations

### Current Support

- **Reference Implementation**: Complete MCP server example
- **Scope3**: Full Signals Activation Protocol support
- **More Coming**: Additional platforms implementing Q1 2025


## Local Development

This repository runs a unified Express server that serves everything from a single process:

- 🏠 **Homepage** at `/`
- 🤖 **Agent Registry** at `/registry` - Browse and test all AdCP agents
- 📋 **AdAgents Manager** at `/adagents` - Validate and create adagents.json files
- 📚 **Mintlify Docs** - Full protocol documentation
- 📄 **JSON Schemas** at `/schemas/*`
- 🔧 **REST API** at `/api/*`
- 📡 **MCP Protocol** at `/mcp`

### Prerequisites

- Node.js 18+
- Docker (for local database)
- npm or yarn

### Quick Start

#### 1. Install Dependencies
```bash
npm install
```

#### 2. Environment Setup

Copy environment template and configure secrets:
```bash
cp .env.local.example .env.local
```

#### 3. Database Setup (Required)

```bash
# Start PostgreSQL in Docker
docker-compose up -d

# Run migrations
npm run db:migrate
```

#### 4. Start Development

**Option 1: Run everything together (recommended)**
```bash
npm run dev
```

This starts:
- **HTTP Server** (blue) - Application on port 3000
- **Mintlify Docs** (green) - Documentation on port 3333
- **Stripe CLI** (magenta) - Webhook forwarding (if Stripe configured)

**Option 2: Run services individually**
```bash
# Terminal 1: Start server
npm start

# Terminal 2: Start docs (optional)
npm run start:mintlify

# Terminal 3: Start Stripe webhooks (optional, if Stripe configured)
npm run start:stripe
```

### Access Points

- http://localhost:3000 - Homepage
- http://localhost:3000/registry - Agent Registry
- http://localhost:3000/adagents - AdAgents.json Manager
- http://localhost:3000/schemas/v1/index.json - Schema Registry
- http://localhost:3000/api/agents - REST API
- http://localhost:3333 - Mintlify Documentation (if running separately)

### Database Operations

```bash
# Run migrations
npm run db:migrate
```

### Other Commands

```bash
# Run tests
npm test

# Type checking
npm run typecheck

# Build TypeScript
npm run build

# Start in MCP mode (stdio)
npm start:mcp
```

### Environment Variables

All environment variables are validated on server startup. See `.env.local.example` for a complete template.

**Server Configuration:**
- `PORT` - Server port (default: 3000)
- `NODE_ENV` - Environment (development|production)
- `MODE` - Server mode (http|mcp)
- `LOG_LEVEL` - Logging level (trace|debug|info|warn|error|fatal, default: debug in dev, info in prod)

**Database Configuration (Required):**
- `DATABASE_URL` - PostgreSQL connection string (**required**)
- `DATABASE_SSL` - Enable SSL (default: false)
- `DATABASE_SSL_REJECT_UNAUTHORIZED` - Verify SSL certificates (default: true when SSL enabled)
- `DATABASE_MAX_POOL_SIZE` - Connection pool size (default: 20)
- `DATABASE_IDLE_TIMEOUT_MS` - Idle timeout (default: 30000)
- `DATABASE_CONNECTION_TIMEOUT_MS` - Connection timeout (default: 5000)

**Authentication (Required for Registry Features):**
- `WORKOS_API_KEY` - WorkOS API key (**required**)
- `WORKOS_CLIENT_ID` - WorkOS OAuth client ID (**required**)
- `WORKOS_COOKIE_PASSWORD` - Session encryption key, min 32 characters (**required**)
- `WORKOS_REDIRECT_URI` - OAuth callback URL (default: http://localhost:3000/auth/callback)

**Billing (Optional - Stripe):**
- `STRIPE_SECRET_KEY` - Stripe secret key (sk_test_... or sk_live_...)
- `STRIPE_PUBLISHABLE_KEY` - Stripe publishable key (pk_test_... or pk_live_...)
- `STRIPE_PRICING_TABLE_ID` - Stripe pricing table ID for subscription UI
- `STRIPE_WEBHOOK_SECRET` - Webhook signing secret (whsec_..., auto-provided by Stripe CLI in dev)

**Note:** The registry is now database-only. `DATABASE_URL` is required to run the server. If the database is unavailable at startup, the server will fail immediately (fail-fast behavior). This ensures you can't accidentally run without proper data persistence.

### Local Stripe Testing

When using `npm run dev` or `npm run start:stripe`, the Stripe CLI forwards webhooks to `localhost:3000/api/webhooks/stripe` and prints the webhook signing secret to the console. Use test card `4242 4242 4242 4242` to create subscriptions.

**Trigger test events:**
```bash
stripe trigger customer.subscription.created
stripe trigger customer.subscription.updated
```

### Analytics & Business Intelligence

AdCP includes integrated analytics powered by Metabase for revenue tracking, customer health metrics, and subscription analytics.

#### Setup Metabase

1. **Start Metabase container:**
```bash
docker-compose -f docker-compose.metabase.yml up -d
```

Metabase will be available at http://localhost:3001

2. **Initial setup** (first time only):
   - Open http://localhost:3001
   - Create an admin account
   - Go to Admin → Settings → Embedding
   - Enable "Embedding in other applications"
   - Copy the embedding secret key

3. **Add Metabase configuration to `.env.local`:**
```bash
METABASE_SITE_URL=http://localhost:3001
METABASE_SECRET_KEY=<your-secret-key-from-metabase>
```

4. **Connect to PostgreSQL database:**
   - In Metabase: Admin → Databases → Add database
   - Type: PostgreSQL
   - Host: `host.docker.internal` (Mac/Windows) or `172.17.0.1` (Linux)
   - Port: `5432` (or your PostgreSQL port from docker-compose)
   - Database: `adcp_registry`
   - Username: `adcp`
   - Password: `localdev`

5. **Create your first dashboard:**
   - Create a new dashboard in Metabase (e.g., "Revenue Analytics")
   - Add queries using the pre-built analytics views (see [ANALYTICS.md](./ANALYTICS.md))
   - Enable embedding for the dashboard (Share → Embedding → Enable)
   - Note the dashboard ID from the URL (e.g., `/dashboard/2` → ID is `2`)

6. **Configure embedded dashboard:**
```bash
# Add to .env.local
METABASE_DASHBOARD_ID=2
```

7. **Restart dev server and access analytics:**
```bash
npm run dev
```

Visit http://localhost:3000/admin/analytics to see your embedded dashboard!

#### Seed Test Revenue Data

To populate the analytics with test data:

```bash
# Seed test revenue events for analytics
psql $DATABASE_URL -f scripts/seed-test-revenue.sql
```

This creates sample revenue events including:
- Initial subscription payments
- Recurring payments over several months
- Sample refunds
- Data for all analytics views

#### Analytics Documentation

For detailed information about:
- Available analytics views (revenue, customer health, subscriptions)
- Example SQL queries
- Dashboard templates
- Troubleshooting

See [ANALYTICS.md](./ANALYTICS.md)

#### Production Analytics

**Recommended Approach: Direct SQL Access**

For low-traffic scenarios, query the production database directly using the pre-built analytics views:

**Available Analytics Views:**
- `monthly_revenue_summary` - Revenue trends by month
- `customer_health` - Active subscriptions and customer status
- `product_revenue` - Revenue breakdown by product
- `revenue_events` - Individual revenue transactions

**Query Examples:**
```sql
-- Monthly revenue trend (last 12 months)
SELECT month, total_revenue / 100.0 as revenue_usd
FROM monthly_revenue_summary
ORDER BY month DESC LIMIT 12;

-- Active subscription count
SELECT COUNT(*) FROM customer_health
WHERE subscription_status = 'active';

-- Revenue by product
SELECT product_name, total_revenue / 100.0 as total_usd
FROM product_revenue
ORDER BY total_revenue DESC;
```

**Access Production Database:**
```bash
# Get connection string from Fly.io secrets
fly ssh console --app adcp-docs -C "echo \$DATABASE_URL"

# Connect with psql
psql <DATABASE_URL>
```

The `/admin/analytics` dashboard provides built-in analytics using SQL views. No external BI tools required.

### Security Requirements

**HTTPS in Production:**

⚠️ **CRITICAL**: Session cookies and authentication tokens must be transmitted over HTTPS in production and staging environments.

- Set `NODE_ENV=production` to enable secure cookies
- Use a reverse proxy (nginx, Caddy, or cloud load balancer) to terminate TLS
- Obtain SSL certificates from Let's Encrypt or your certificate provider
- Update `WORKOS_REDIRECT_URI` to use https:// scheme

**Development Setup:**

In local development, cookies are sent over HTTP for convenience. This is acceptable only on localhost. For staging environments, always use HTTPS even if using self-signed certificates.

**Generating Secure Secrets:**

```bash
# Generate WORKOS_COOKIE_PASSWORD (min 32 characters)
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### Docker Deployment

```dockerfile
FROM node:18
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN npm run build
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "start"]
```

## License

The Ad Context Protocol specifications are licensed under [Apache 2.0](./LICENSE).

## Contact

- **General Inquiries**: hello@adcontextprotocol.org
- **Technical Support**: support@adcontextprotocol.org  
- **Security Issues**: security@adcontextprotocol.org
- **Partnership**: partnerships@adcontextprotocol.org

## Use Cases

### For Advertising Technology Companies
- Build unified advertising automation tools
- Integrate with multiple platforms through single API
- Enable AI-powered advertising workflows
- Create MCP-compatible advertising servers

### For Agencies and Advertisers  
- Automate campaign management across all platforms
- Use natural language for advertising operations
- Get unified analytics and reporting
- Reduce integration and maintenance costs

### For Publishers and Ad Networks
- Expose inventory through standardized protocol
- Enable AI assistant integration
- Participate in automated advertising ecosystem
- Implement once, work with all AI tools

## Keywords

`advertising automation`, `programmatic advertising API`, `MCP advertising integration`, `AI advertising workflows`, `unified advertising platform API`, `advertising protocol standard`, `Model Context Protocol advertising`, `cross-platform advertising automation`

## Links

- **Website**: [adcontextprotocol.org](https://adcontextprotocol.org)
- **API Documentation**: [Advertising Automation API](https://adcontextprotocol.org/advertising-automation-api)
- **MCP Integration**: [MCP Advertising Guide](https://adcontextprotocol.org/mcp-advertising-integration)
- **Specifications**: [Signals Protocol RFC](docs/signals/specification.mdx)
- **Discussions**: [GitHub Discussions](https://github.com/adcontextprotocol/adcp/discussions)
- **Issues**: [Report Issues](https://github.com/adcontextprotocol/adcp/issues)

---

Built with ❤️ by the advertising technology community.
