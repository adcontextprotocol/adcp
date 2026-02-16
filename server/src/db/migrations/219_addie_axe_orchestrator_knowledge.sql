-- Teach Addie how AXE is implemented in practice: orchestrators integrate
-- AXE into ad serving environments through various paths.
-- Supplements existing Prebid knowledge (migration 218).

INSERT INTO addie_rules (rule_type, name, description, content, priority, created_by) VALUES
(
  'knowledge',
  'AXE Orchestrator Implementation',
  'How orchestrators implement AXE across different ad serving environments, with Scope3 as the reference implementation',
  'AXE is a protocol-level concept. Orchestrators implement AXE and integrate it into ad serving environments. The integration path depends on the ad platform.

## Integration Paths

AXE can be deployed in several ways:

1. **Prebid RTD module** - Orchestrator distributes a Prebid module that calls the AXE endpoint during auction. Example: Scope3''s scope3RtdProvider. The module name in Prebid matches the orchestrator, not "AXE."
2. **Proprietary ad platform** - AXE runs as a container or secure enclave within the platform''s infrastructure. Segment evaluation happens natively in the platform''s decisioning pipeline, with no external call at impression time.
3. **Server-side** - AXE endpoint called server-to-server by the ad platform before decisioning. Custom ad server integration.

Regardless of integration path, AXE evaluates segments and returns axei/axex/axem decisions.

## Scope3 as AXE Implementer

Scope3 is the reference AXE implementation. They integrate via Prebid RTD module (scope3RtdProvider):

1. Publisher''s Prebid config includes scope3RtdProvider
2. Module sends request to https://agentic.scope3.com (the AXE endpoint)
3. AXE evaluates segments and returns axei/axex/axem values
4. Values passed as key-values to the ad server
5. Line items match on segment key-values

## Connecting the Dots

- The axe_integrations URL in get_adcp_capabilities (e.g., "https://agentic.scope3.com") maps to a specific orchestrator''s AXE endpoint
- A seller declaring axe_integrations: ["https://agentic.scope3.com"] means they integrate with Scope3''s AXE — possibly via Prebid RTD module, container, or other path
- Scope3''s RTD module in Prebid IS one implementation of AXE — protocol vs implementation are different views of the same thing

## Identifying AXE on a Publisher Page (Web/Prebid)

When users ask about a web publisher''s Prebid setup and AXE support:
- Look for orchestrator RTD modules: scope3RtdProvider in pbjs.installedModules or the Prebid source
- Check realTimeData.dataProviders config for name: "scope3" (or other orchestrator names)
- Check network tab for axei/axex/axem key-values in ad server requests
- A publisher with scope3RtdProvider loaded supports AXE targeting through Scope3

## Identifying AXE on Proprietary Platforms

For proprietary ad platforms, AXE may be integrated as a container or secure enclave:
- Check get_adcp_capabilities for axe_integrations URLs
- The platform handles AXE internally — no visible Prebid module
- Segment protocol (axei/axex/axem) is the same regardless of deployment

## What This Means for Publishers

Publishers don''t implement AXE directly. Depending on their ad platform:
- **Prebid publishers**: Add the orchestrator''s RTD module to their build
- **Proprietary platforms**: AXE is integrated by the platform or orchestrator
- In both cases, the orchestrator handles segment evaluation and the publisher configures targeting in their ad server',
  163,
  'system'
);
