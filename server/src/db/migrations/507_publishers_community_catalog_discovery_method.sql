-- Treat approved community catalog documents as first-class adagents.json
-- records for publisher lookup. These are not publisher-origin fetches, so
-- they need distinct provenance from direct / authoritative_location /
-- ads_txt_managerdomain / manager-file fan-out.

BEGIN;

ALTER TABLE publishers DROP CONSTRAINT publishers_discovery_method_check;
ALTER TABLE publishers
  ADD CONSTRAINT publishers_discovery_method_check
  CHECK (discovery_method IN (
    'direct',
    'authoritative_location',
    'ads_txt_managerdomain',
    'adagents_authoritative',
    'community_catalog'
  ));

COMMENT ON COLUMN publishers.discovery_method IS
  'How the publisher''s authorization/catalog was discovered on the most recent successful crawl or registry write. '
  '''direct'': publisher''s own /.well-known/ served the document. '
  '''authoritative_location'': publisher''s stub redirected to a third-party canonical URL. '
  '''ads_txt_managerdomain'': discovery fell back to a manager domain via ads.txt MANAGERDOMAIN delegation. '
  '''adagents_authoritative'': child publisher synthesized from a manager file''s publisher_properties[].publisher_domains[] fan-out. '
  '''community_catalog'': moderator-approved community adagents.json catalog attached to this publisher domain; not publisher-origin attested.';

COMMIT;
