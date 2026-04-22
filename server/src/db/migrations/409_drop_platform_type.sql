-- Drop platform_type from agent_registry_metadata.
--
-- @adcp/client 5.1.0 replaces the AAO's platform_type concept with
-- capability-driven selection: agents declare supported_protocols and
-- specialisms in get_adcp_capabilities, and the compliance runner resolves
-- those to storyboard bundles. The column is no longer written or read
-- anywhere in the codebase.
ALTER TABLE agent_registry_metadata DROP COLUMN IF EXISTS platform_type;
