import { beforeEach, describe, expect, it, vi } from 'vitest';

const proveAgentWebhookControlMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/training-agent/webhook-challenge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/training-agent/webhook-challenge.js')>();
  return { ...actual, proveAgentWebhookControl: proveAgentWebhookControlMock };
});

const { clearSessions, flushDirtySessions, runWithSessionContext } = await import('../../src/training-agent/state.js');
const {
  DESTINATION_PROOF_DELAY_MS,
  PRINCIPAL_CAPABILITY,
  getPrincipalLegacy,
  principalKindFor,
  syncPrincipalLegacy,
} = await import('../../src/training-agent/principal.js');
const { syncAgentNotificationConfigsLegacy } = await import('../../src/training-agent/agent-notification-configs.js');
const { isMutatingTool } = await import('../../src/training-agent/idempotency.js');
const { customToolFor } = await import('../../src/training-agent/tenants/custom-tool-helper.js');
const { TOOL_INPUT_SHAPES } = await import('@adcp/sdk/schemas');

type Ctx = Parameters<typeof syncPrincipalLegacy>[1];
type Json = Record<string, any>;

const subscriber = (overrides: Json = {}) => ({
  subscriber_id: 'events',
  url: 'https://buyer.example/hooks',
  event_types: ['capabilities.changed'],
  active: false,
  ...overrides,
});

const T0 = Date.parse('2027-01-01T00:00:00Z');
const caller = (principal = 'static:buyer-a'): Ctx => ({ mode: 'open', principal });
const anonymous: Ctx = { mode: 'open', principal: 'anonymous' };

let keyCounter = 0;
const key = () => `principal-test-key-${String(++keyCounter).padStart(6, '0')}`;

function destination(overrides: Json = {}): Json {
  return {
    pattern: 'file_transfer',
    destination_id: 'compliance-archive',
    active: false,
    provider: { domain: 'object-store.example' },
    transport: 's3',
    location: 's3://pinnacle-reporting/compliance/',
    accepted_formats: ['parquet'],
    accepted_verification_profiles: ['manifest_checksums'],
    ...overrides,
  };
}

// Mirrors customToolFor: one session context per call, flushed afterwards.
const inSession = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithSessionContext(async () => {
    const result = await fn();
    await flushDirtySessions();
    return result;
  });

const sync = (configuration: Json, ctx: Ctx = caller(), extra: Json = {}, now = T0) =>
  inSession(() =>
    syncPrincipalLegacy({ idempotency_key: key(), configuration, ...extra } as never, ctx, () => now),
  ) as Promise<Json>;

const read = (ctx: Ctx = caller(), now = T0, args: Json = {}) =>
  inSession(() => getPrincipalLegacy(args as never, ctx, () => now)) as Promise<Json>;

beforeEach(async () => {
  await clearSessions();
  proveAgentWebhookControlMock.mockReset();
  proveAgentWebhookControlMock.mockResolvedValue({ ok: true, normalizedUrl: 'https://buyer.example/hooks' });
});

describe('principal layer: identity', () => {
  it('rejects anonymous callers on both tasks', async () => {
    for (const result of [await sync({ declarations: {} }, anonymous), await read(anonymous)]) {
      expect(result.errors).toMatchObject([{ code: 'AUTH_REQUIRED' }]);
      expect(result).not.toHaveProperty('result');
    }
  });

  it('maps API-key principals to buyer_agent and per-user principals to operator', () => {
    expect(principalKindFor({ principal: 'static:public' })).toBe('buyer_agent');
    expect(principalKindFor({ principal: 'workos:org_123' })).toBe('buyer_agent');
    expect(principalKindFor({ principal: 'workos:user_123' })).toBe('operator');
  });

  it('refuses identity supplied in the request body', async () => {
    for (const field of ['buyer_agent_url', 'agent_url', 'principal_id', 'connection_id']) {
      const synced = await sync({ declarations: {} }, caller(), { [field]: 'https://evil.example' });
      expect(synced.result).toMatchObject({ kind: 'failed', errors: [{ code: 'INVALID_REQUEST' }] });
      const got = await read(caller(), T0, { [field]: 'https://evil.example' });
      expect(got.result).toMatchObject({ kind: 'failed', errors: [{ code: 'INVALID_REQUEST' }] });
    }
  });

  it('reads a recognized identity without creating state, then a stable id after apply', async () => {
    const first = await read();
    expect(first.result).toMatchObject({ kind: 'recognized', principal_kind: 'buyer_agent' });
    expect(first.result).not.toHaveProperty('configuration_version');
    expect(first.result).not.toHaveProperty('configuration');
    expect(await read()).toEqual(first);

    const applied = await sync({ reporting_destinations: [destination()] });
    expect(applied.result.principal_id).toBe(first.result.principal_id);
    expect(applied.result.principal_id).not.toContain('buyer-a');
    const current = await read();
    expect(current.result).toMatchObject({
      kind: 'current',
      principal_id: first.result.principal_id,
      configuration_version: applied.result.configuration_version,
    });
  });

  it('isolates principals from each other', async () => {
    await sync({ reporting_destinations: [destination()] }, caller('static:buyer-a'));
    const other = await read(caller('static:buyer-b'));
    expect(other.result.kind).toBe('recognized');
    expect(other.result.principal_id).not.toBe((await read(caller('static:buyer-a'))).result.principal_id);
  });
});

describe('principal layer: reporting destinations', () => {
  it('dry run validates without persisting', async () => {
    const result = await sync({ reporting_destinations: [destination()] }, caller(), { dry_run: true });
    expect(result.result).toEqual({ kind: 'validated', dry_run: true, action: 'would_update' });
    expect((await read()).result.kind).toBe('recognized');
    expect((await sync({ reporting_destinations: [] }, caller(), { dry_run: true })).result.action).toBe('would_be_unchanged');
  });

  it('applies a suspended destination as inactive and replays to the same generation', async () => {
    const applied = await sync({ reporting_destinations: [destination()] });
    const [record] = applied.result.configuration.reporting_destinations;
    expect(applied.result).toMatchObject({ kind: 'applied', action: 'updated', dry_run: false });
    expect(record).toMatchObject({ destination_id: 'compliance-archive', state: 'inactive' });
    expect(record.destination_ref).toMatch(/^dest_/);

    const again = await sync({ reporting_destinations: [destination()] });
    expect(again.result.action).toBe('unchanged');
    expect(again.result.configuration_version).toBe(applied.result.configuration_version);
    expect(again.result.configuration.reporting_destinations[0].destination_ref).toBe(record.destination_ref);
  });

  it('moves an active destination from action_required to ready without advancing the version', async () => {
    const applied = await sync({ reporting_destinations: [destination({ active: true })] });
    const pending = applied.result.configuration.reporting_destinations[0];
    expect(pending).toMatchObject({ state: 'action_required', setup: { action: 'prove_control' } });

    const later = await read(caller(), T0 + DESTINATION_PROOF_DELAY_MS);
    expect(later.result.configuration.reporting_destinations[0]).toMatchObject({
      state: 'ready',
      destination_ref: pending.destination_ref,
    });
    expect(later.result.configuration.reporting_destinations[0]).not.toHaveProperty('setup');
    expect(later.result.configuration_version).toBe(applied.result.configuration_version);
  });

  it('issues a new generation when delivery coordinates change and keeps the old reference', async () => {
    const first = await sync({ reporting_destinations: [destination()] });
    const ref = first.result.configuration.reporting_destinations[0].destination_ref;
    const suspendedOnly = await sync({ reporting_destinations: [destination({ active: true })] });
    expect(suspendedOnly.result.configuration.reporting_destinations[0].destination_ref).toBe(ref);
    expect(suspendedOnly.result.configuration_version).not.toBe(first.result.configuration_version);

    const moved = await sync({ reporting_destinations: [destination({ location: 's3://pinnacle-reporting/other/' })] });
    const next = moved.result.configuration.reporting_destinations[0];
    expect(next.destination_ref).not.toBe(ref);
    expect(next.prior_destination_refs).toEqual([ref]);
  });

  it('treats set-valued fields as unordered', async () => {
    const first = await sync({ reporting_destinations: [destination({ accepted_formats: ['parquet', 'csv'], accepted_verification_profiles: ['manifest_checksums', 'canonical_digest'] })] });
    const reordered = await sync({ reporting_destinations: [destination({ accepted_formats: ['csv', 'parquet'], accepted_verification_profiles: ['canonical_digest', 'manifest_checksums'] })] });
    expect(reordered.result.action).toBe('unchanged');
    expect(reordered.result.configuration_version).toBe(first.result.configuration_version);
    expect(reordered.result.configuration.reporting_destinations[0].destination_ref)
      .toBe(first.result.configuration.reporting_destinations[0].destination_ref);
  });

  it('issues a fresh generation when a retired destination_id is registered again', async () => {
    const first = await sync({ reporting_destinations: [destination()] });
    const ref = first.result.configuration.reporting_destinations[0].destination_ref;
    await sync({ reporting_destinations: [] });
    const again = await sync({ reporting_destinations: [destination()] });
    const record = again.result.configuration.reporting_destinations[0];
    expect(record.destination_ref).not.toBe(ref);
    expect(again.result.configuration.retired_destinations[0].destination_refs).toEqual([ref]);
  });

  it('normalizes location casing so equivalent coordinates keep their generation', async () => {
    const first = await sync({ reporting_destinations: [destination({ location: 'S3://Pinnacle-Reporting//compliance/' })] });
    expect(first.result.configuration.reporting_destinations[0].configuration.location)
      .toBe('s3://pinnacle-reporting/compliance/');
    const again = await sync({ reporting_destinations: [destination()] });
    expect(again.result.action).toBe('unchanged');
  });

  it('retires omitted destinations and reports cleared when every section is empty', async () => {
    const applied = await sync({ reporting_destinations: [destination(), destination({ destination_id: 'second' })] });
    const refs = applied.result.configuration.reporting_destinations.map((d: Json) => d.destination_ref);

    const partial = await sync({ reporting_destinations: [destination()] });
    expect(partial.result.configuration.retired_destinations).toMatchObject([
      { destination_id: 'second', destination_refs: [refs[1]] },
    ]);

    const cleared = await sync({ reporting_destinations: [] });
    expect(cleared.result).toMatchObject({ action: 'cleared' });
    expect(cleared.result.configuration.reporting_destinations).toEqual([]);
    expect(cleared.result.configuration.retired_destinations.map((r: Json) => r.destination_id).sort())
      .toEqual(['compliance-archive', 'second']);
    expect((await read()).result).toMatchObject({ kind: 'current' });
  });

  it.each([
    ['an unoffered pattern', {
      pattern: 'dataset_share',
      destination_id: 'share',
      active: false,
      provider: { domain: 'object-store.example' },
      transport: 'delta_sharing',
      access_mode: 'open_sharing',
      recipient: { identity: 'recipient-1' },
      accepted_verification_profiles: ['canonical_digest'],
    }, 'UNSUPPORTED_FEATURE'],
    ['an unoffered transport', destination({ transport: 'azure_blob' }), 'UNSUPPORTED_FEATURE'],
    ['unoffered verification profiles', destination({ accepted_verification_profiles: ['native_commit'] }), 'UNSUPPORTED_FEATURE'],
    ['credentials in the location', destination({ location: 's3://key:secret@bucket/prefix/' }), 'INVALID_REQUEST'],
    ['an access key id in the location authority', destination({ location: 's3://AKIAEXAMPLE@bucket/prefix/' }), 'INVALID_REQUEST'],
  ])('fails the whole request for %s', async (_label, bad, code) => {
    const result = await sync({ reporting_destinations: [bad] });
    expect(result).toMatchObject({ status: 'failed', result: { kind: 'failed', errors: [{ code }] } });
    expect(JSON.stringify(result)).not.toContain('principal_id');
  });

  it('rejects duplicate destination ids and keeps prior sections atomic', async () => {
    await sync({ declarations: { async_adcp_versions: ['3.2'] } });
    const before = await read();
    const result = await sync({
      declarations: { async_adcp_versions: ['3.1'] },
      reporting_destinations: [destination(), destination()],
    });
    expect(result.result).toMatchObject({ kind: 'failed', errors: [{ code: 'INVALID_REQUEST' }] });
    expect(await read()).toEqual(before);
  });
});

describe('principal layer: concurrency and fences', () => {
  it('enforces expected_configuration_version and expected_principal_kind', async () => {
    const stale = await sync({ declarations: {} }, caller(), { expected_configuration_version: 'cfg_nothing' });
    expect(stale.result.errors[0]).toMatchObject({ code: 'CONFLICT', field: 'expected_configuration_version' });

    const applied = await sync({ reporting_destinations: [destination()] });
    const guarded = await sync({ reporting_destinations: [] }, caller(), {
      expected_configuration_version: applied.result.configuration_version,
      expected_principal_kind: 'buyer_agent',
    });
    expect(guarded.result).toMatchObject({ kind: 'applied', action: 'cleared' });
    expect(guarded.result.configuration_version).not.toBe(applied.result.configuration_version);

    const reused = await sync({ reporting_destinations: [destination()] }, caller(), {
      expected_configuration_version: applied.result.configuration_version,
    });
    expect(reused.result.errors[0].code).toBe('CONFLICT');

    const kind = await sync({ declarations: {} }, caller(), { expected_principal_kind: 'operator' });
    expect(kind.result.errors[0]).toMatchObject({ code: 'CONFLICT', field: 'expected_principal_kind' });
  });
});

describe('principal layer: declarations', () => {
  it('echoes the declared set and returns the accepted intersection with exclusions', async () => {
    const applied = await sync({
      declarations: {
        async_adcp_versions: ['3.2', '9.9'],
        webhook_signing_algorithms: ['ed25519', 'ecdsa-p256-sha256'],
        experimental_features: ['protocol.principal', 'future.feature'],
      },
    });
    const declarations = applied.result.configuration.declarations;
    expect(declarations.declared.async_adcp_versions).toEqual(['3.2', '9.9']);
    expect(declarations.accepted).toEqual({
      async_adcp_versions: ['3.2'],
      webhook_signing_algorithms: ['ed25519'],
      experimental_features: ['protocol.principal'],
    });
    expect(declarations.selected_async_adcp_version).toBe('3.2');
    expect(declarations.exclusions.map((e: Json) => e.value).sort())
      .toEqual(['9.9', 'ecdsa-p256-sha256', 'future.feature']);
    expect((await read()).result.configuration.declarations).toEqual(declarations);
  });

  it('clears the declared set with {}', async () => {
    await sync({ declarations: { async_adcp_versions: ['3.2'] } });
    const cleared = await sync({ declarations: {} });
    expect(cleared.result).toMatchObject({ action: 'cleared' });
    expect(cleared.result.configuration.declarations).toEqual({ declared: {}, accepted: {} });
  });

  it('fails when no declared signing algorithm intersects while a webhook subscriber is active', async () => {
    await inSession(() => syncAgentNotificationConfigsLegacy({
      idempotency_key: key(),
      notification_configs: [subscriber({ active: true })],
    } as never, caller()));
    const result = await sync({ declarations: { webhook_signing_algorithms: ['ecdsa-p256-sha256'] } });
    expect(result.result).toMatchObject({ kind: 'failed', errors: [{ code: 'UNSUPPORTED_FEATURE' }] });
    expect((await read()).result.kind).toBe('recognized');

    // The same declaration is fine once no subscriber is active.
    await inSession(() => syncAgentNotificationConfigsLegacy({
      idempotency_key: key(),
      notification_configs: [],
    } as never, caller()));
    expect((await sync({ declarations: { webhook_signing_algorithms: ['ecdsa-p256-sha256'] } })).result.kind).toBe('applied');
  });
});

describe('principal layer: request validation', () => {
  it.each([
    ['an empty configuration', {}],
    ['an unknown section', { bogus: [] }],
    ['an unknown destination property', { reporting_destinations: [destination({ access_key: 'AKIAEXAMPLE' })] }],
    ['an unknown declarations property', { declarations: { api_token: 'x' } }],
    ['a signed-URL location', { reporting_destinations: [destination({ location: 's3://pinnacle/p?X-Amz-Signature=abc' })] }],
  ])('rejects %s without persisting', async (_label, configuration) => {
    const result = await sync(configuration);
    expect(result.result).toMatchObject({ kind: 'failed', errors: [{ code: 'INVALID_REQUEST' }] });
    expect((await read()).result.kind).toBe('recognized');
  });

  it('rejects the notification_configs section because it is not advertised', async () => {
    const result = await sync({ notification_configs: [subscriber()] });
    expect(result.result).toMatchObject({ kind: 'failed', errors: [{ code: 'UNSUPPORTED_FEATURE' }] });
    expect(PRINCIPAL_CAPABILITY.supported_sections).not.toContain('notification_configs');
  });
});

describe('principal layer: through the custom-tool wrapper', () => {
  const tool = customToolFor('sync_principal', 'test', TOOL_INPUT_SHAPES.sync_principal!, syncPrincipalLegacy, {
    enforceIdempotency: true,
  });
  const call = async (args: Json): Promise<Json> =>
    (await tool.handler(args as never, { authInfo: { clientId: 'static:wrapped' } } as never)) as Json;

  it('replays an applied sync, and keeps the key reusable after a stale-version failure', async () => {
    const body = { idempotency_key: 'wrapped-key-0000000001', configuration: { reporting_destinations: [destination()] } };
    const applied = await call(body);
    const replayed = await call(body);
    expect(replayed.structuredContent.replayed).toBe(true);
    expect(replayed.structuredContent.result).toEqual(applied.structuredContent.result);

    // A newly applied change advances the version; the original replay still resolves first.
    await call({ idempotency_key: 'wrapped-key-0000000002', configuration: { reporting_destinations: [] } });
    expect((await call(body)).structuredContent.result).toEqual(applied.structuredContent.result);

    // A failed (stale-version) result is not a completed operation: it is not
    // cached, so a retry re-executes instead of replaying the failure.
    const stale = { idempotency_key: 'wrapped-key-0000000003', expected_configuration_version: 'cfg_stale', configuration: { declarations: {} } };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const failedAttempt = await call(stale);
      expect(failedAttempt.structuredContent.result.errors[0].code).toBe('CONFLICT');
      expect(failedAttempt.structuredContent.replayed).toBeUndefined();
    }
  });

  it('turns a missing principal into an AUTH_REQUIRED error', async () => {
    const result = await tool.handler({ idempotency_key: 'wrapped-key-0000000004', configuration: { declarations: {} } } as never, {} as never) as Json;
    expect(result.isError).toBe(true);
    expect(result.structuredContent.adcp_error.code).toBe('AUTH_REQUIRED');
  });
});

describe('principal layer: advertisement', () => {
  it('advertises every supported section with its required companions', () => {
    expect(PRINCIPAL_CAPABILITY.supported_sections).toEqual(['reporting_destinations', 'declarations']);
    expect(PRINCIPAL_CAPABILITY).toMatchObject({
      sync_task: 'sync_principal',
      read_task: 'get_principal',
      optimistic_concurrency: true,
    });
    expect(isMutatingTool('sync_principal')).toBe(true);
    expect(isMutatingTool('get_principal')).toBe(false);
  });
});
