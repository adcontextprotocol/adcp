import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const registryApiSource = readFileSync(
  new URL('../server/src/routes/registry-api.ts', import.meta.url),
  'utf8',
);
const httpSource = readFileSync(
  new URL('../server/src/http.ts', import.meta.url),
  'utf8',
);

describe('hosted SDK safe-fetch call sites', () => {
  it('scopes the registry client-credentials diagnostic exchange', () => {
    expect(registryApiSource).toContain(
      'exchangeClientCredentials(creds, { fetch: sdkSafeFetch })',
    );
  });

  it('does not use ambient fetch for hosted A2A probes', () => {
    expect(registryApiSource).not.toContain('await fetch(a2aUrl');
    expect(httpSource).not.toContain('await fetch(a2aUrl');
    expect(registryApiSource).toContain('await sdkSafeFetch(a2aUrl');
    expect(httpSource).toContain('await sdkSafeFetch(a2aUrl');
  });

  it('does not construct unscoped public discovery clients', () => {
    const unsafeCreativeConstructor = 'new CreativeAgentClient({ agentUrl: url })';
    expect(registryApiSource).not.toContain(unsafeCreativeConstructor);
    expect(httpSource).not.toContain(unsafeCreativeConstructor);
    expect(registryApiSource).toContain(
      '}], withSdkSafeTransport({})).agent("creative-capability-discovery")',
    );
    expect(registryApiSource).toContain(
      '}], publicAgentTransportOptions()).agent("creative-capability-discovery")',
    );
    expect(registryApiSource).toContain('return withSdkSafeTransport({');
    expect(registryApiSource).toContain('maxResponseBytes: PUBLIC_AGENT_RESPONSE_BYTES');
    expect(registryApiSource).toContain('requestTimeoutMs: PUBLIC_AGENT_TIMEOUT_MS');
    expect(httpSource).toContain(
      'new CreativeAgentClient(withSdkSafeTransport({ agentUrl: url }))',
    );
    expect(registryApiSource.split(
      '}], withSdkSafeTransport({})).agent("creative-capability-discovery")',
    )).toHaveLength(2);
    expect(registryApiSource.split(
      '}], publicAgentTransportOptions()).agent("creative-capability-discovery")',
    )).toHaveLength(2);
    expect(httpSource.split('}, withSdkSafeTransport({}));')).toHaveLength(2);
  });
});
