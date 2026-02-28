# AdCP - Advertising Context Protocol

**Open standard for advertising automation over MCP and A2A protocols**

[![Documentation](https://img.shields.io/badge/docs-adcontextprotocol.org-blue)](https://docs.adcontextprotocol.org)
[![GitHub stars](https://img.shields.io/github/stars/adcontextprotocol/adcp?style=social)](https://github.com/adcontextprotocol/adcp)
[![MCP Compatible](https://img.shields.io/badge/MCP-compatible-green)](https://modelcontextprotocol.io)

AdCP is an open standard that enables AI agents to discover inventory, buy media, build creatives, activate audiences, and manage accounts across advertising platforms. It defines domain-specific tasks and schemas that work over [MCP](https://modelcontextprotocol.io) and [A2A](https://google.github.io/A2A/) as transports.

## Documentation

**[docs.adcontextprotocol.org](https://docs.adcontextprotocol.org)** — Full protocol specification, integration guides, and task reference.

## Protocols

| Protocol | Description | Key tasks |
|----------|-------------|-----------|
| **Media Buy** | Inventory discovery, campaign creation, delivery reporting | `get_products`, `create_media_buy`, `get_media_buy_delivery` |
| **Creative** | Ad creative management across channels | `build_creative`, `preview_creative`, `list_creative_formats` |
| **Signals** | Audience and targeting data activation | `get_signals`, `activate_signal` |
| **Accounts** | Commercial identity and billing | `sync_accounts`, `list_accounts`, `report_usage` |
| **Governance** | Brand suitability and content standards | `create_content_standards`, `calibrate_content` |
| **Brand** | Brand identity discovery and resolution | `brand.json` well-known file |
| **Sponsored Intelligence** | Conversational brand experiences | `si_initiate_session`, `si_send_message` |
| **Curation** | Media inventory curation | Coming soon |

## Repository structure

```
adcontextprotocol/
├── docs/                  # Protocol documentation (Mintlify)
│   ├── media-buy/         # Media Buy protocol
│   ├── creative/          # Creative protocol
│   ├── signals/           # Signals protocol
│   ├── accounts/          # Accounts protocol
│   ├── governance/        # Governance protocol
│   ├── brand-protocol/    # Brand protocol
│   └── sponsored-intelligence/
├── server/                # Express server (registry, API, MCP)
│   ├── src/               # TypeScript source
│   └── public/            # Static pages (homepage, registry UI)
├── static/
│   ├── schemas/           # JSON schemas
│   └── openapi/           # OpenAPI specs
├── tests/                 # Schema validation and integration tests
└── scripts/               # Build and release tooling
```

## Local development

### Prerequisites

- Node.js 20+
- Docker

### Setup

```bash
npm install
docker compose up --build    # Starts PostgreSQL + app with auto-migrations
```

The server runs on port 3000. Docs run separately with `mintlify dev` on port 3333.

### Commands

```bash
npm test          # Run tests (schemas, examples, migrations)
npm run build     # Build TypeScript
npm run typecheck # Type check
npm run lint      # Lint
```

See [CLAUDE.md](./CLAUDE.md) for detailed development guidelines.

## JSON schemas

Schemas are available at `/schemas/latest/`:

- **Registry**: `/schemas/latest/index.json`
- **Core objects**: `/schemas/latest/core/*.json`
- **Task schemas**: `/schemas/latest/media-buy/*.json`, `/schemas/latest/signals/*.json`
- **Enums**: `/schemas/latest/enums/*.json`

See [static/schemas/README.md](./static/schemas/README.md) for validation examples.

## Contributing

We welcome contributions from platform providers, agencies, developers, and industry experts. See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines. All contributors must agree to the [IPR Policy](./IPR_POLICY.md).

## Community

- [GitHub Discussions](https://github.com/adcontextprotocol/adcp/discussions)
- [Working Group](https://docs.adcontextprotocol.org/docs/community/working-group) — Monthly meetings, first Wednesday of each month

## Links

- [Protocol documentation](https://docs.adcontextprotocol.org)
- [AgenticAdvertising.org](https://agenticadvertising.org) — Member organization
- [Release notes](https://docs.adcontextprotocol.org/docs/reference/release-notes)
- [Roadmap](https://docs.adcontextprotocol.org/docs/reference/roadmap)

## License

Licensed under [Apache 2.0](./LICENSE).
