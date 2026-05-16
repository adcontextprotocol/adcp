---
"adcontextprotocol": patch
---

Fix: XSS in the adagents.json builder when rendering a hostile remote `adagents.json` or agent card. Any admin who validated a domain whose `adagents.json` or A2A agent-card contained script tags / event handlers in `card_data.name`, `validation.errors[*]`, `validation.warnings[*]`, `agent_cards[*].errors`, `agent_url`, or `domain` would have executed attacker-controlled JS in the admin's session.

Reflections in `displayValidationResults()` and `displayAgentCardsResults()` now route every interpolated field through `escapeHtml()`, including the raw-data `<pre>` block (which previously emitted unescaped JSON, letting an attacker break out with `</pre><script>`).

Also retires the legacy quick-add creator path (`startCreating()` and `updateUIForCreateOrUpdate()`): the entry-point DOM IDs were already removed when the v3 builder landed, leaving the v2-shape-emitting handlers orphaned. The supported `startManaging()` flow is the only entry point. `resetCreator()` was updated to stop referencing the removed IDs.

Adds a jsdom-driven regression test that loads the static page, calls the two reflection helpers with hostile payloads (script tags, `<img onerror>`, `</pre>` break-out), and asserts no executable nodes land in the DOM and no global side-effect fires. Closes adcp#4468.
