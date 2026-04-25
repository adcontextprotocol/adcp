---
---

Add baseline integration coverage for the federated index + property registry reader functions ahead of the property registry unification (issue #3177).

Tests-only, no production code changes. PR 1 (#3195) shipped the empty `publishers` + `adagents_authorization_overrides` schema. PR 4 will swap the readers under `getPropertiesForAgent` / `getPropertiesForDomain` / `getAgentsForDomain` / `validateAgentForProduct` / `getAllPropertiesForRegistry` and friends, plus the public registry endpoints (`/registry/agents`, `/registry/publishers`, `/registry/publisher`, `/registry/operator`, `/registry/stats`) and the directory MCP tools (`lookup_domain`, `list_publishers`), to consult the new schema. These four new test files pin the I/O of the current readers — same fixtures, same response shapes / counts / ordering — so the cutover fails loudly if it changes any caller-visible behavior.
