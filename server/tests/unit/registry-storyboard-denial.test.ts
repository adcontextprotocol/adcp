import { describe, expect, it, vi } from 'vitest';
import { PreparedFixturesDeniedError } from '@adcp/sdk/testing';
const mocks = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../../src/compliance/catalog-reporting-runner.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/compliance/catalog-reporting-runner.js')>()),
  runCatalogReportingStoryboardStep: (...args: unknown[]) => mocks.run(...args),
}));
vi.mock('../../src/services/agent-ownership.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/services/agent-ownership.js')>()),
  resolveOwnerOrgForUser: async () => 'org_test',
}));
vi.mock('../../src/routes/helpers/resolve-user-agent-auth.js', () => ({
  resolveUserAgentAuth: async () => undefined,
}));
vi.mock('../../src/services/sdk-auth-adapter.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/services/sdk-auth-adapter.js')>()),
  adaptAuthForSdk: async () => undefined,
}));
vi.mock('../../src/addie/services/compliance-testing.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/addie/services/compliance-testing.js')>()),
  selectComplianceTargetForAgent: async () => (await import('../../src/services/hosted-compliance-version.js')).hostedComplianceTarget('3.2.5'),
}));
import { createRegistryApiRouters } from '../../src/routes/registry-api.js';
import { registry } from '../../src/schemas/registry.js';

describe('actual registry storyboard step handler refusal mapping', () => {
  it('returns only typed denial codes as403 and passes an overall deadline', async () => {
    mocks.run.mockRejectedValue(new PreparedFixturesDeniedError('authorizer_denied'));
    const { router } = createRegistryApiRouters({ requireAuth: (_req, _res, next) => next() } as Parameters<typeof createRegistryApiRouters>[0]);
    // Invoke the registered business handler with an already-authenticated
    // session/ownership result; this test does not bypass those gates in production.
    const route = router.stack.find(layer => layer.route?.path === '/registry/agents/:encodedUrl/storyboard/:storyboardId/step/:stepId')!.route!;
    const handler = route.stack.at(-1)!.handle;
    let status = 200, body: unknown;
    const response = { status(code: number) { status = code; return this; }, json(value: unknown) { body = value; return this; } };
    await handler({ params: { encodedUrl: encodeURIComponent('https://seller.example/mcp'),
      storyboardId: 'media_buy_seller/advanced_delivery_reporting', stepId: 'create_buy' },
      user: { id: 'user_test' }, body: {}, path: '/test' }, response, () => {});
    expect(status).toBe(403);
    expect(body).toEqual({ code: 'PREPARED_FIXTURES_DENIED', refusal_code: 'authorizer_denied' });
    const definition = registry.definitions.find(entry => entry.type === 'route' && entry.route.operationId === 'runStoryboardStep');
    if (!definition || definition.type !== 'route') throw new Error('Step OpenAPI definition missing');
    const responseSchema = definition.route.responses[403];
    if ('$ref' in responseSchema) throw new Error('Expected inline step response');
    const schema = responseSchema.content!['application/json'].schema;
    expect(schema.safeParse(body).success, 'documented403 must accept the actual typed denial').toBe(true);
    expect(mocks.run).toHaveBeenCalledOnce();
    expect(mocks.run.mock.calls[0][3].signal).toBeInstanceOf(AbortSignal);
  });
});
