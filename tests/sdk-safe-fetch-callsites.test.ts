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
      'new CreativeAgentClient(withSdkSafeTransport({ agentUrl: url }))',
    );
    expect(httpSource).toContain(
      'new CreativeAgentClient(withSdkSafeTransport({ agentUrl: url }))',
    );
    expect(registryApiSource.split('}, withSdkSafeTransport({}));')).toHaveLength(3);
    expect(httpSource.split('}, withSdkSafeTransport({}));')).toHaveLength(2);
  });
});
