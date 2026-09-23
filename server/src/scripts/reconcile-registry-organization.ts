/**
 * Dry-run-first repair for an existing registry organization, WorkOS domain,
 * and WorkOS API key. This never creates an organization, domain, key, or
 * agent. Apply mode delegates domain writes to the audited global-admin
 * recovery endpoints and only probes `/api/me/agents` with the existing key.
 *
 * Required identifiers:
 *   --org-id <WorkOS organization id>
 *   --domain <domain>
 *   --api-key-id <WorkOS API key id>
 *
 * Optional:
 *   --api-key-name <expected name>
 *   --api-key-env <environment variable containing the existing key value>
 *   --base-url <deployed application URL>
 *   --attestation <operator DNS verification note>
 *   --make-primary
 *   --apply
 */

import { resolveTxt } from 'node:dns/promises';
import { pathToFileURL } from 'node:url';
import { WorkOS } from '@workos-inc/node';
import { closeDatabase, getPool } from '../db/client.js';

interface Args {
  orgId: string;
  domain: string;
  apiKeyId: string;
  apiKeyName?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  attestation?: string;
  makePrimary: boolean;
  apply: boolean;
}

function valueAfter(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

export function parseArgs(argv: string[]): Args {
  const orgId = valueAfter(argv, '--org-id');
  const domain = valueAfter(argv, '--domain')?.toLowerCase();
  const apiKeyId = valueAfter(argv, '--api-key-id');
  if (!orgId || !domain || !apiKeyId) {
    throw new Error('--org-id, --domain, and --api-key-id are required');
  }
  return {
    orgId,
    domain,
    apiKeyId,
    apiKeyName: valueAfter(argv, '--api-key-name'),
    apiKeyEnv: valueAfter(argv, '--api-key-env'),
    baseUrl: valueAfter(argv, '--base-url') ?? process.env.BASE_URL,
    attestation: valueAfter(argv, '--attestation'),
    makePrimary: argv.includes('--make-primary'),
    apply: argv.includes('--apply'),
  };
}

export function dnsRecordName(domain: string, verificationPrefix?: string | null): string {
  return verificationPrefix ? `${verificationPrefix}.${domain}` : domain;
}

function keyOrganizationId(key: Awaited<ReturnType<WorkOS['apiKeys']['createValidation']>>['apiKey']): string | null {
  if (!key) return null;
  return key.owner.type === 'organization' ? key.owner.id : key.owner.organizationId;
}

async function requestJson(url: string, init: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  const text = await response.text();
  let body: any = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = { error: 'non_json_response' }; }
  }
  return { status: response.status, body };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const workosSecret = process.env.WORKOS_API_KEY;
  if (!workosSecret) throw new Error('WORKOS_API_KEY is required');
  const workos = new WorkOS(workosSecret, {
    clientId: process.env.WORKOS_CLIENT_ID,
    timeout: 5_000,
    maxRetries: 0,
  });
  const pool = getPool();

  try {
    const [localOrg, localDomain, profile, workosOrg, keyInventory] = await Promise.all([
      pool.query(
        `SELECT workos_organization_id, name, email_domain, is_personal,
                membership_tier, subscription_status
           FROM organizations WHERE workos_organization_id = $1`,
        [args.orgId],
      ),
      pool.query(
        `SELECT domain, workos_organization_id, verified, is_primary, source,
                created_at, updated_at
           FROM organization_domains WHERE domain = $1`,
        [args.domain],
      ),
      pool.query(
        `SELECT id, workos_organization_id, slug, is_public, agents
           FROM member_profiles WHERE workos_organization_id = $1`,
        [args.orgId],
      ),
      workos.organizations.getOrganization(args.orgId),
      workos.apiKeys.listOrganizationApiKeys({ organizationId: args.orgId }),
    ]);

    if (localOrg.rowCount !== 1) throw new Error(`Local organization ${args.orgId} was not found`);
    const workosDomain = workosOrg.domains.find((entry) => entry.domain.toLowerCase() === args.domain);
    if (!workosDomain) throw new Error(`WorkOS organization ${args.orgId} does not contain ${args.domain}`);
    const txtRecordName = dnsRecordName(args.domain, workosDomain.verificationPrefix);
    const txtRecords = await resolveTxt(txtRecordName).catch(() => [] as string[][]);

    const listedKey = keyInventory.data.find((key) => key.id === args.apiKeyId);
    let validatedKey = null;
    if (args.apiKeyEnv) {
      const value = process.env[args.apiKeyEnv];
      if (!value) throw new Error(`${args.apiKeyEnv} is not set`);
      validatedKey = (await workos.apiKeys.createValidation({ value })).apiKey;
      if (!validatedKey || validatedKey.id !== args.apiKeyId) {
        throw new Error('The supplied existing key value does not validate to --api-key-id');
      }
    }
    const observedKey = validatedKey ?? listedKey;
    if (!observedKey) {
      throw new Error('The API key was not found in the target organization inventory; pass --api-key-env so its exact WorkOS scope can be validated without printing the secret');
    }
    if (args.apiKeyName && observedKey.name !== args.apiKeyName) {
      throw new Error(`API key name mismatch for ${args.apiKeyId}`);
    }
    const observedKeyOrg = keyOrganizationId(observedKey);
    if (observedKeyOrg !== args.orgId) {
      throw new Error(`API key ${args.apiKeyId} is scoped to ${observedKeyOrg ?? 'no organization'}, not ${args.orgId}`);
    }

    const publishedTxt = txtRecords.flat();
    const dnsTokenMatches = Boolean(
      workosDomain.verificationToken
      && publishedTxt.includes(workosDomain.verificationToken),
    );
    const snapshot = {
      mode: args.apply ? 'apply' : 'dry-run',
      organization: localOrg.rows[0],
      local_domain: localDomain.rows[0] ?? null,
      member_profile: profile.rows[0]
        ? {
            ...profile.rows[0],
            agents: Array.isArray(profile.rows[0].agents)
              ? profile.rows[0].agents.map((agent: any) => ({ url: agent?.url, type: agent?.type, visibility: agent?.visibility }))
              : [],
          }
        : null,
      workos_domain: {
        id: workosDomain.id,
        domain: workosDomain.domain,
        organization_id: workosDomain.organizationId,
        state: workosDomain.state,
        verification_strategy: workosDomain.verificationStrategy,
        verification_prefix: workosDomain.verificationPrefix ?? null,
        dns_record_name: txtRecordName,
        dns_token_matches: dnsTokenMatches,
        created_at: workosDomain.createdAt,
        updated_at: workosDomain.updatedAt,
      },
      api_key: {
        id: observedKey.id,
        name: observedKey.name,
        owner_type: observedKey.owner.type,
        organization_id: observedKeyOrg,
        permissions: observedKey.permissions,
        created_at: observedKey.createdAt,
        updated_at: observedKey.updatedAt,
        last_used_at: observedKey.lastUsedAt,
      },
    };
    console.log(JSON.stringify(snapshot, null, 2));

    if (!args.apply) {
      console.log('DRY-RUN: no writes performed. Deploy the API-key association fix, then rerun with --apply and the existing key supplied via --api-key-env.');
      return;
    }
    if (!args.baseUrl) throw new Error('--base-url or BASE_URL is required in apply mode');
    const adminKey = process.env.ADMIN_API_KEY;
    if (!adminKey) throw new Error('ADMIN_API_KEY is required in apply mode');
    if (!args.apiKeyEnv) throw new Error('--api-key-env is required in apply mode to probe the existing credential');

    const headers = { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' };
    const domainPath = `${args.baseUrl.replace(/\/$/, '')}/api/admin/organizations/${encodeURIComponent(args.orgId)}/domains/${encodeURIComponent(args.domain)}`;
    let domainRepair = await requestJson(`${domainPath}/verify`, { method: 'POST', headers, body: '{}' });
    if (domainRepair.status === 400 && domainRepair.body?.error === 'still_pending') {
      if (!dnsTokenMatches) throw new Error('WorkOS remains pending and the exact challenge token is not visible in public DNS');
      if (!args.attestation) throw new Error('--attestation is required to use the audited manual verification override');
      domainRepair = await requestJson(`${domainPath}/override-verification`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          verification_attestation: args.attestation,
          is_primary: args.makePrimary,
        }),
      });
    }
    if (domainRepair.status < 200 || domainRepair.status >= 300) {
      throw new Error(`Audited domain repair failed with HTTP ${domainRepair.status}: ${domainRepair.body?.error ?? 'unknown error'}`);
    }

    const existingKeyValue = process.env[args.apiKeyEnv]!;
    const keyProbe = await requestJson(`${args.baseUrl.replace(/\/$/, '')}/api/me/agents`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${existingKeyValue}` },
    });
    if (keyProbe.status !== 200 && keyProbe.status !== 404) {
      throw new Error(`Existing API key organization probe failed with HTTP ${keyProbe.status}: ${keyProbe.body?.error ?? 'unknown error'}`);
    }

    console.log(JSON.stringify({
      success: true,
      domain_repair_status: domainRepair.status,
      api_key_probe_status: keyProbe.status,
      agent_registered: false,
    }, null, 2));
  } finally {
    await closeDatabase();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
