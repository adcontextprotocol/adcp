---
---

Fix "Already connected to a transport" under concurrent POST requests to the training-agent tenant router by creating a fresh MCP Server per request instead of reusing the registry singleton. Adds `createServer(tenantId)` factory to `RegistryHolder` and a regression test for concurrent back-to-back requests.
