# Addie conformance demo

Three-line integration that lets your AdCP/MCP server connect outbound
to Addie. Once connected, Addie can run storyboards against your dev
environment and surface bugs in chat — no public DNS, no ngrok, no
inbound exposure.

```ts
import { ConformanceClient } from '@adcp/sdk/server';
import { mcpServer } from './my-mcp-server.js';

const client = new ConformanceClient({
  url: 'wss://addie.agenticadvertising.org/conformance/connect',
  token: process.env.ADCP_CONFORMANCE_TOKEN!,
  server: mcpServer,
});

await client.start();
```

`ConformanceClient` ships from `@adcp/sdk` ≥ 6.9. Adopters who already
install the SDK get it for free; no separate package to manage.

## Getting a token

Ask Addie in chat: *"give me a fresh conformance token."* The token is
bound to your WorkOS organization and expires in one hour. Re-ask Addie
when it expires.

Alternatively, `POST /api/conformance/token` with a WorkOS session
cookie or API key. Response: `{ token, url, expires_at, ttl_seconds }`.

## Running this demo

```sh
ADCP_CONFORMANCE_TOKEN=<token> \
ADCP_CONFORMANCE_URL=ws://localhost:3000/conformance/connect \
  npx tsx examples/conformance-client/demo.ts
```

The demo stands up a tiny MCP server with `ping` and `echo` tools and
holds the socket until Ctrl-C. Verify the connection registered by
hitting `GET /api/conformance/_debug` (dev only).

## Privacy posture

- **Dev/staging only.** Production deployments MUST NOT expose this
  channel — same constraint as `comply_test_controller` per
  [adcontextprotocol/adcp#3986](https://github.com/adcontextprotocol/adcp/issues/3986).
- **Session-scoped.** You explicitly run the client and supply a fresh
  token. Stop the process to disconnect — there is no persistent tunnel.
- **What Addie sees:** whatever your MCP server returns when she calls
  `tools/list`/`tools/call`. Treat the channel as you would any other
  thing you tell Addie in chat.
