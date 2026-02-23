-- Blocked domains registry: known ad tech infrastructure that should not appear
-- in publisher property lists. Maintained server-side so every implementor benefits.

CREATE TABLE IF NOT EXISTS blocked_domains (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain TEXT NOT NULL UNIQUE,
  domain_type TEXT NOT NULL CHECK (domain_type IN ('ad_server', 'intermediary', 'cdn', 'tracker')),
  reason TEXT,
  added_by TEXT NOT NULL DEFAULT 'system',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed: ad servers
INSERT INTO blocked_domains (domain, domain_type, reason) VALUES
  ('googlesyndication.com', 'ad_server', 'Google ad serving'),
  ('doubleclick.net', 'ad_server', 'Google ad serving (DoubleClick)'),
  ('googleadservices.com', 'ad_server', 'Google ad services'),
  ('googletagservices.com', 'ad_server', 'Google Tag Services'),
  ('2mdn.net', 'ad_server', 'Google ad serving'),
  ('adnxs.com', 'ad_server', 'Xandr/Microsoft ad exchange'),
  ('adnxs-simple.com', 'ad_server', 'Xandr/Microsoft ad exchange'),
  ('openx.net', 'ad_server', 'OpenX ad exchange'),
  ('rubiconproject.com', 'ad_server', 'Magnite/Rubicon ad exchange'),
  ('pubmatic.com', 'ad_server', 'PubMatic ad exchange'),
  ('criteo.com', 'ad_server', 'Criteo retargeting'),
  ('criteo.net', 'ad_server', 'Criteo retargeting'),
  ('outbrain.com', 'ad_server', 'Outbrain recommendation network'),
  ('taboola.com', 'ad_server', 'Taboola recommendation network'),
  ('advertising.com', 'ad_server', 'Oath/Verizon ad network'),
  ('moatads.com', 'ad_server', 'Oracle Moat measurement'),
  ('lijit.com', 'ad_server', 'Sovrn ad network'),
  ('contextweb.com', 'ad_server', 'Pulsepoint ad exchange'),
  ('indexexchange.com', 'ad_server', 'Index Exchange'),
  ('casalemedia.com', 'ad_server', 'Index Exchange (legacy)'),
  ('smartadserver.com', 'ad_server', 'Smart AdServer'),
  ('tremorhub.com', 'ad_server', 'Tremor Video/Amobee'),
  ('yieldmo.com', 'ad_server', 'Yieldmo ad platform'),
  ('appnexus.com', 'ad_server', 'Xandr/Microsoft (AppNexus legacy)'),
  ('districtm.io', 'ad_server', 'District M ad exchange'),
  ('sharethrough.com', 'ad_server', 'Sharethrough native ad exchange'),
  ('triplelift.com', 'ad_server', 'TripleLift native exchange'),
  ('emxdgt.com', 'ad_server', 'EMX Digital exchange'),
  ('bidswitch.net', 'ad_server', 'IPONWEB BidSwitch'),
  ('adsrvr.org', 'ad_server', 'The Trade Desk ad serving'),
  ('media.net', 'ad_server', 'Media.net ad network')
ON CONFLICT (domain) DO NOTHING;

-- Seed: known intermediaries (obfuscate actual publisher supply)
INSERT INTO blocked_domains (domain, domain_type, reason) VALUES
  ('microsoftadvertising.com', 'intermediary', 'Microsoft advertising intermediary — obscures actual publisher'),
  ('advertising.microsoft.com', 'intermediary', 'Microsoft advertising intermediary'),
  ('ads.microsoft.com', 'intermediary', 'Microsoft advertising intermediary'),
  ('googleadmanager.com', 'intermediary', 'Google Ad Manager — intermediary, not a publisher'),
  ('admob.com', 'intermediary', 'Google AdMob — mobile ad intermediary'),
  ('mopub.com', 'intermediary', 'Twitter MoPub — mobile ad intermediary (acquired/retired)'),
  ('amazon-adsystem.com', 'intermediary', 'Amazon advertising intermediary'),
  ('a9.com', 'intermediary', 'Amazon advertising intermediary')
ON CONFLICT (domain) DO NOTHING;

-- Seed: CDNs
INSERT INTO blocked_domains (domain, domain_type, reason) VALUES
  ('cloudfront.net', 'cdn', 'AWS CloudFront CDN'),
  ('fastly.net', 'cdn', 'Fastly CDN'),
  ('fastly.com', 'cdn', 'Fastly CDN'),
  ('akamaized.net', 'cdn', 'Akamai CDN'),
  ('akamaistream.net', 'cdn', 'Akamai streaming CDN'),
  ('akamai.net', 'cdn', 'Akamai CDN'),
  ('cloudflare.net', 'cdn', 'Cloudflare CDN'),
  ('cloudflare.com', 'cdn', 'Cloudflare CDN'),
  ('edgekey.net', 'cdn', 'Akamai EdgeKey CDN'),
  ('edgesuite.net', 'cdn', 'Akamai EdgeSuite CDN'),
  ('llnwd.net', 'cdn', 'Limelight Networks CDN'),
  ('b-cdn.net', 'cdn', 'BunnyCDN'),
  ('azureedge.net', 'cdn', 'Microsoft Azure CDN'),
  ('vo.msecnd.net', 'cdn', 'Microsoft CDN')
ON CONFLICT (domain) DO NOTHING;

-- Seed: trackers/measurement
INSERT INTO blocked_domains (domain, domain_type, reason) VALUES
  ('scorecardresearch.com', 'tracker', 'comScore measurement'),
  ('quantserve.com', 'tracker', 'Quantcast measurement'),
  ('chartbeat.com', 'tracker', 'Chartbeat analytics'),
  ('newrelic.com', 'tracker', 'New Relic monitoring'),
  ('nr-data.net', 'tracker', 'New Relic data collection'),
  ('parsely.com', 'tracker', 'Parse.ly content analytics'),
  ('dpmsrvr.com', 'tracker', 'Datapoint Media tracker'),
  ('adsymptotic.com', 'tracker', 'Ad measurement tracker'),
  ('idsync.rlcdn.com', 'tracker', 'LiveRamp identity sync'),
  ('rlcdn.com', 'tracker', 'LiveRamp CDN/identity'),
  ('krxd.net', 'tracker', 'Salesforce Krux DMP'),
  ('bluekai.com', 'tracker', 'Oracle BlueKai DMP'),
  ('imrworldwide.com', 'tracker', 'Nielsen measurement'),
  ('doubleverify.com', 'tracker', 'DoubleVerify brand safety'),
  ('adsafeprotected.com', 'tracker', 'IAS (Integral Ad Science)'),
  ('moatpixel.com', 'tracker', 'Oracle Moat pixel')
ON CONFLICT (domain) DO NOTHING;
