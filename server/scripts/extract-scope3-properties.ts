/**
 * Extract publisher-property mappings from Scope3 BigQuery and generate
 * a SQL migration for seeding the AAO community registry.
 *
 * Usage: npx tsx server/scripts/extract-scope3-properties.ts
 *
 * Prerequisites: gcloud auth (bokelley@scope3.com)
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT = 'swift-catfish-337215';
const P = PROJECT; // short alias for table refs

function tbl(dataset: string, table: string): string {
  return '`' + P + '.' + dataset + '.' + table + '`';
}

// ---------------------------------------------------------------------------
// Scope3 → AdCP mappings
// ---------------------------------------------------------------------------

const CHANNEL_MAP: Record<string, { property_type: string; channels: string[] } | null> = {
  'DISPLAY-WEB':       { property_type: 'website',         channels: ['display'] },
  'DISPLAY-APP':       { property_type: 'mobile_app',      channels: ['display'] },
  'STREAMING-VIDEO':   { property_type: 'website',         channels: ['olv'] },
  'CTV-BVOD':          { property_type: 'ctv_app',         channels: ['ctv'] },
  'DIGITAL-AUDIO':     { property_type: 'streaming_audio', channels: ['streaming_audio'] },
  'TRADITIONAL-RADIO': { property_type: 'radio',           channels: ['radio'] },
  'SOCIAL':            { property_type: 'mobile_app',      channels: ['social'] },
  'SEARCH':            { property_type: 'website',         channels: ['search'] },
  // Skip these channels:
  'DOOH':         null,
  'CLASSIC-OOH':  null,
  'LINEAR-TV':    null,
  'PRINT':        null,
};

// Channels where a property with the same name should be merged (add channels)
// rather than creating a separate property entry
const MERGEABLE_CHANNELS: Record<string, boolean> = {
  'STREAMING-VIDEO': true,  // OLV for a website domain is the same property
};

function mapInventoryType(inventoryType: string, value: string, channel: string): { type: string; value: string } | null {
  switch (inventoryType) {
    case 'SITE':
      return { type: 'domain', value };
    case 'GOOGLE_PLAY_STORE':
      // Reverse-domain names are android_package, numeric IDs are google_play_id
      if (/^[a-z]/.test(value) && value.includes('.')) {
        return { type: 'android_package', value };
      }
      return { type: 'google_play_id', value };
    case 'APPLE_APP_STORE':
      // Numeric = app store ID, reverse-domain = ios_bundle
      if (/^\d+$/.test(value)) {
        return { type: 'apple_app_store_id', value };
      }
      return { type: 'ios_bundle', value };
    case 'ROKU':
      return { type: 'roku_store_id', value };
    case 'SAMSUNG':
      return { type: 'samsung_app_id', value };
    case 'AMAZON':
      return { type: 'fire_tv_asin', value };
    case 'SCREEN':
      return { type: 'screen_id', value };
    case 'PANEL':
      return { type: 'venue_id', value };
    case 'ALIAS':
      return { type: 'network_id', value };
    case 'LG':
    case 'MICROSOFT':
    case 'PUBLICATION':
      return { type: 'network_id', value };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// BigQuery helpers
// ---------------------------------------------------------------------------

function bqQuery(sql: string): unknown[] {
  const cmd = `bq query --project_id=${PROJECT} --use_legacy_sql=false --max_rows=1000000 --format=json '${sql.replace(/'/g, "'\\''")}'`;
  const result = execSync(cmd, { maxBuffer: 500 * 1024 * 1024, encoding: 'utf-8' });
  const trimmed = result.trim();
  if (!trimmed || trimmed === '[]') return [];
  return JSON.parse(trimmed);
}

// ---------------------------------------------------------------------------
// Types for BQ results
// ---------------------------------------------------------------------------

interface OrgRow {
  org_id: string;
  publisher_name: string;
  parent_name: string | null;
}

interface PropertyRow {
  org_id: string;
  property_name: string;
  channel: string;
  ads_txt_domain: string | null;
  app_group_id: string | null;
}

interface InventoryRow {
  org_id: string;
  property_name: string;
  channel: string;
  inventory_identifier: string;
  inventory_type: string;
}

// AdCP types
interface AdcpIdentifier {
  type: string;
  value: string;
}

interface AdcpProperty {
  property_type: string;
  name: string;
  identifiers: AdcpIdentifier[];
  supported_channels: string[];
  publisher_domain?: string;
}

interface AdagentsJson {
  contact: { name: string };
  properties: AdcpProperty[];
  authorized_agents: never[];
  last_updated: string;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('Step 1: Fetching publishers...');
  const orgTable = tbl('postgres_datastream', 'public_organization');
  const propTable = tbl('postgres_datastream', 'public_property');
  const chanTable = tbl('postgres_datastream', 'public_channel');
  const domTable = tbl('postgres_datastream', 'public_domain');
  const invTable = tbl('organizations', 'property_inventory_mappings');

  const orgFilter = [
    'o.is_generic = false',
    'NOT REGEXP_CONTAINS(o.name, r"^[0-9a-f]{8}-")',
    'NOT REGEXP_CONTAINS(o.name, r"^\\d{10,}")',
    'o.name NOT LIKE "(old%"',
    'LENGTH(TRIM(o.name)) > 2',
  ].join(' AND ');

  const orgs = bqQuery([
    'SELECT o.id as org_id, o.name as publisher_name, parent.name as parent_name',
    'FROM ' + orgTable + ' o',
    'LEFT JOIN ' + orgTable + ' parent ON o.parent_id = parent.id',
    'WHERE ' + orgFilter,
    'AND EXISTS (SELECT 1 FROM ' + propTable + ' p WHERE p.organization_id = o.id AND p.archived_at IS NULL)',
    'ORDER BY o.name',
  ].join('\n')) as OrgRow[];
  console.log(`  Found ${orgs.length} publishers`);

  const channels = "'DISPLAY-WEB', 'DISPLAY-APP', 'CTV-BVOD', 'STREAMING-VIDEO', 'DIGITAL-AUDIO', 'SOCIAL', 'SEARCH', 'TRADITIONAL-RADIO'";

  console.log('Step 2: Fetching properties (web, app, CTV, OLV, audio)...');
  const properties = bqQuery([
    'SELECT o.id as org_id, p.name as property_name, c.channel, d.domain as ads_txt_domain, p.app_group_id',
    'FROM ' + orgTable + ' o',
    'JOIN ' + propTable + ' p ON p.organization_id = o.id',
    'JOIN ' + chanTable + ' c ON c.id = p.channel_id',
    'LEFT JOIN ' + domTable + ' d ON d.id = p.ads_txt_domain_id',
    'WHERE ' + orgFilter,
    'AND p.archived_at IS NULL',
    'AND c.channel IN (' + channels + ')',
    'ORDER BY o.id, c.channel, p.name',
  ].join('\n')) as PropertyRow[];
  console.log(`  Found ${properties.length} properties`);

  // Fetch inventory mappings per channel (web is too large and redundant, skip it)
  const invChannels = [
    'DISPLAY-APP', 'CTV-BVOD', 'STREAMING-VIDEO',
    'DIGITAL-AUDIO', 'SOCIAL', 'SEARCH', 'TRADITIONAL-RADIO',
  ];
  console.log('Step 3: Fetching inventory mappings (non-web channels)...');
  let inventoryMappings: InventoryRow[] = [];
  for (const ch of invChannels) {
    console.log(`  Querying ${ch}...`);
    const rows = bqQuery([
      'SELECT pim.organization_id as org_id, pim.property_name, pim.channel, pim.inventory_identifier, pim.inventory_type',
      'FROM ' + invTable + ' pim',
      'WHERE pim.ymd = (SELECT MAX(ymd) FROM ' + invTable + ')',
      "AND pim.channel = '" + ch + "'",
      'ORDER BY pim.organization_id, pim.property_name',
    ].join('\n')) as InventoryRow[];
    inventoryMappings = inventoryMappings.concat(rows);
    console.log(`    ${rows.length} rows`);
  }
  console.log(`  Total inventory mappings: ${inventoryMappings.length}`);

  // Index orgs
  const orgMap = new Map<string, OrgRow>();
  for (const org of orgs) {
    orgMap.set(org.org_id, org);
  }

  // Group properties by org
  const propsByOrg = new Map<string, PropertyRow[]>();
  for (const prop of properties) {
    if (!orgMap.has(prop.org_id)) continue;
    const list = propsByOrg.get(prop.org_id) || [];
    list.push(prop);
    propsByOrg.set(prop.org_id, list);
  }

  // Index inventory mappings by (org_id, property_name, channel)
  const invKey = (orgId: string, propName: string, channel: string) =>
    `${orgId}|${propName}|${channel}`;
  const invByProp = new Map<string, InventoryRow[]>();
  for (const inv of inventoryMappings) {
    const key = invKey(inv.org_id, inv.property_name, inv.channel);
    const list = invByProp.get(key) || [];
    list.push(inv);
    invByProp.set(key, list);
  }

  console.log('Step 4: Building adagents.json per publisher...');

  const diagnostics = { skippedNoId: 0, merged: 0, noDomain: 0, dupDomain: 0 };

  // For each publisher, determine a publisher_domain and build properties
  const publisherRecords: Array<{
    publisher_domain: string;
    publisher_name: string;
    adagents_json: AdagentsJson;
  }> = [];

  for (const org of orgs) {
    const orgProps = propsByOrg.get(org.org_id);
    if (!orgProps || orgProps.length === 0) continue;

    // Determine the publisher_domain
    const webProps = orgProps.filter(p => p.channel === 'DISPLAY-WEB');
    let publisherDomain: string | null = null;

    // Strategy: find the best publisher_domain
    const orgNameLower = org.publisher_name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const allDomains = webProps.map(p => (p.ads_txt_domain || p.property_name).toLowerCase()).filter(d => d.includes('.'));

    if (allDomains.length > 0) {
      // Try 1: exact org name match (e.g. "Spotify" -> "spotify.com")
      const exactMatch = allDomains.find(d => {
        const base = d.split('.')[0];
        return base === orgNameLower;
      });
      if (exactMatch) {
        publisherDomain = exactMatch;
      } else {
        // Try 2: org name contained in domain base
        const partialMatch = allDomains.find(d => {
          const base = d.replace(/\.[^.]+$/, '').replace(/[^a-z0-9]/g, '');
          return base.includes(orgNameLower) || orgNameLower.includes(base);
        });
        if (partialMatch) {
          publisherDomain = partialMatch;
        } else {
          // Try 3: pick the shortest domain (usually the primary)
          const sorted = [...allDomains].sort((a, b) => a.length - b.length);
          publisherDomain = sorted[0];
        }
      }
    }

    if (!publisherDomain) {
      // Fallback: look for a domain in any property (e.g. streaming video site domain)
      const anyDomainProp = orgProps.find(p =>
        p.ads_txt_domain && p.ads_txt_domain.includes('.')
      );
      if (anyDomainProp) {
        publisherDomain = anyDomainProp.ads_txt_domain!.toLowerCase();
      }
    }

    if (!publisherDomain) {
      // Fallback: derive from org name
      const sanitized = org.publisher_name.toLowerCase()
        .replace(/[^a-z0-9.-]/g, '')
        .replace(/\.+$/, '');
      if (sanitized.includes('.') && sanitized.length > 3) {
        publisherDomain = sanitized;
      }
    }

    if (!publisherDomain) {
      diagnostics.noDomain++;
      continue;
    }

    // Deduplicate: if we've already built a record for this domain, skip
    if (publisherRecords.some(r => r.publisher_domain === publisherDomain)) {
      diagnostics.dupDomain++;
      continue;
    }

    // Build AdCP properties array
    const adcpProperties: AdcpProperty[] = [];
    // Track by name for channel merging (e.g., OLV adds 'olv' to existing website)
    const propByName = new Map<string, AdcpProperty>();

    // Diagnostics
    let skippedNoId = 0;
    let merged = 0;

    for (const prop of orgProps) {
      const channelMapping = CHANNEL_MAP[prop.channel];
      if (!channelMapping) continue;

      // Build identifiers from inventory mappings
      const identifiers: AdcpIdentifier[] = [];
      const seenIds = new Set<string>();

      const invMappings = invByProp.get(invKey(org.org_id, prop.property_name, prop.channel)) || [];
      for (const inv of invMappings) {
        const mapped = mapInventoryType(inv.inventory_type, inv.inventory_identifier, inv.channel);
        if (!mapped) continue;
        const idKey = `${mapped.type}:${mapped.value}`;
        if (seenIds.has(idKey)) continue;
        seenIds.add(idKey);
        identifiers.push(mapped);
      }

      // Fallback: web properties use domain from property name / ads_txt_domain
      if (identifiers.length === 0 && prop.channel === 'DISPLAY-WEB') {
        const domain = (prop.ads_txt_domain || prop.property_name).toLowerCase();
        if (domain && domain.includes('.')) {
          identifiers.push({ type: 'domain', value: domain });
        }
      }

      // Fallback: app properties use app_group_id
      if (identifiers.length === 0 && prop.app_group_id) {
        const agId = prop.app_group_id;
        if (agId.startsWith('Apple$')) {
          // Apple app store numeric ID
          const appleId = agId.replace('Apple$', '');
          identifiers.push({ type: 'apple_app_store_id', value: appleId });
        } else if (/^[a-z]/.test(agId) && agId.includes('.')) {
          // Reverse-domain bundle ID
          identifiers.push({ type: 'android_package', value: agId });
        } else if (/^\d+$/.test(agId)) {
          // Numeric data.ai unified product ID - use as network_id
          identifiers.push({ type: 'network_id', value: agId });
        }
      }

      // Fallback: OLV/streaming properties use domain from property name
      if (identifiers.length === 0 && (prop.channel === 'STREAMING-VIDEO' || prop.channel === 'DIGITAL-AUDIO')) {
        const domain = (prop.ads_txt_domain || prop.property_name).toLowerCase();
        if (domain && domain.includes('.')) {
          identifiers.push({ type: 'domain', value: domain });
        }
      }

      // If mergeable channel and we already have this property, just add the channel
      if (MERGEABLE_CHANNELS[prop.channel] && propByName.has(prop.property_name)) {
        const existing = propByName.get(prop.property_name)!;
        for (const ch of channelMapping.channels) {
          if (!existing.supported_channels.includes(ch)) {
            existing.supported_channels.push(ch);
          }
        }
        // Also merge any new identifiers
        for (const id of identifiers) {
          const idKey = `${id.type}:${id.value}`;
          if (!existing.identifiers.some(e => `${e.type}:${e.value}` === idKey)) {
            existing.identifiers.push(id);
          }
        }
        merged++;
        continue;
      }

      // Skip properties with no identifiers
      if (identifiers.length === 0) {
        skippedNoId++;
        continue;
      }

      // Dedup: skip if we already have this exact property_type + name combo
      const dedupKey = `${channelMapping.property_type}|${prop.property_name}`;
      if (propByName.has(dedupKey)) continue;

      // Limit identifiers to 20 per property to keep size reasonable
      const trimmedIdentifiers = identifiers.slice(0, 20);

      const adcpProp: AdcpProperty = {
        property_type: channelMapping.property_type,
        name: prop.property_name,
        identifiers: trimmedIdentifiers,
        supported_channels: [...channelMapping.channels],
      };
      adcpProperties.push(adcpProp);
      propByName.set(prop.property_name, adcpProp);
      propByName.set(dedupKey, adcpProp);
    }

    if (skippedNoId > 10) {
      diagnostics.skippedNoId += skippedNoId;
    }
    diagnostics.merged += merged;

    if (adcpProperties.length === 0) continue;

    const adagentsJson: AdagentsJson = {
      contact: { name: org.publisher_name },
      properties: adcpProperties,
      authorized_agents: [],
      last_updated: new Date().toISOString(),
    };

    publisherRecords.push({
      publisher_domain: publisherDomain,
      publisher_name: org.publisher_name,
      adagents_json: adagentsJson,
    });
  }

  console.log(`  Generated ${publisherRecords.length} publisher records`);

  // Stats
  let totalProps = 0;
  let totalIds = 0;
  for (const rec of publisherRecords) {
    totalProps += rec.adagents_json.properties.length;
    for (const prop of rec.adagents_json.properties) {
      totalIds += prop.identifiers.length;
    }
  }
  console.log(`  Total properties: ${totalProps}`);
  console.log(`  Total identifiers: ${totalIds}`);
  console.log(`  Diagnostics:`);
  console.log(`    Orgs with no usable domain: ${diagnostics.noDomain}`);
  console.log(`    Orgs with duplicate domain: ${diagnostics.dupDomain}`);
  console.log(`    Properties skipped (no identifiers): ${diagnostics.skippedNoId}`);
  console.log(`    Properties merged (OLV→website): ${diagnostics.merged}`);

  // ---------------------------------------------------------------------------
  // Generate SQL migration
  // ---------------------------------------------------------------------------

  console.log('Step 5: Generating SQL migration...');

  const sqlLines: string[] = [
    '-- Migration: 206_seed_properties.sql',
    '-- Purpose: Seed publisher-property mappings from Scope3 BigQuery data',
    '-- Source: swift-catfish-337215 (organizations + property_inventory_mappings)',
    `-- Generated: ${new Date().toISOString()}`,
    `-- Publishers: ${publisherRecords.length}`,
    `-- Properties: ${totalProps}`,
    `-- Identifiers: ${totalIds}`,
    '',
    '-- Insert publishers as enriched properties (from Scope3 data)',
    '-- ON CONFLICT DO NOTHING to avoid overwriting existing records',
    '',
    "INSERT INTO hosted_properties (publisher_domain, adagents_json, source_type, is_public, review_status)",
    'VALUES',
  ];

  const valueLines: string[] = [];
  for (const rec of publisherRecords) {
    const domain = rec.publisher_domain.replace(/'/g, "''");
    const json = JSON.stringify(rec.adagents_json).replace(/'/g, "''");
    valueLines.push(`  ('${domain}', '${json}'::jsonb, 'enriched', true, 'approved')`);
  }

  sqlLines.push(valueLines.join(',\n'));
  sqlLines.push('ON CONFLICT (publisher_domain) DO NOTHING;');
  sqlLines.push('');

  const migrationPath = path.join(
    __dirname, '..', 'src', 'db', 'migrations', '206_seed_properties.sql'
  );
  fs.writeFileSync(migrationPath, sqlLines.join('\n'));

  console.log(`  Wrote migration to: ${migrationPath}`);
  console.log(`  File size: ${(fs.statSync(migrationPath).size / 1024 / 1024).toFixed(1)} MB`);

  // Print a few samples
  console.log('\nSample records:');
  const samples = ['gannett', 'spotify', 'pandora', 'new york times'];
  for (const name of samples) {
    const rec = publisherRecords.find(r =>
      r.publisher_name.toLowerCase().includes(name)
    );
    if (rec) {
      console.log(`\n  ${rec.publisher_name} (${rec.publisher_domain}):`);
      console.log(`    Properties: ${rec.adagents_json.properties.length}`);
      const byType = new Map<string, number>();
      for (const p of rec.adagents_json.properties) {
        byType.set(p.property_type, (byType.get(p.property_type) || 0) + 1);
      }
      for (const [type, count] of byType) {
        console.log(`      ${type}: ${count}`);
      }
      // Show first 3 properties
      for (const p of rec.adagents_json.properties.slice(0, 3)) {
        console.log(`    - ${p.name} (${p.property_type}): ${p.identifiers.map(i => `${i.type}=${i.value}`).join(', ')}`);
      }
    }
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
