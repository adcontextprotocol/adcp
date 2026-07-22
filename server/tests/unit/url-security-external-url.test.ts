import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isTestOrDevelopmentRuntime,
  validateExternalUrl,
} from '../../src/utils/url-security.js';

describe('validateExternalUrl runtime policy', () => {
  let originalEnvironment: string | undefined;

  beforeEach(() => {
    originalEnvironment = process.env.NODE_ENV;
  });

  afterEach(() => {
    if (originalEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalEnvironment;
  });

  function setEnvironment(environment: string | undefined): void {
    if (environment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = environment;
  }

  it.each([
    ['test', true],
    ['development', true],
    ['production', false],
    ['staging', false],
    ['developmnt', false],
    [undefined, false],
  ])('classifies the %s runtime explicitly', (environment, expected) => {
    expect(isTestOrDevelopmentRuntime(environment)).toBe(expected);
  });

  it.each(['production', 'staging', 'developmnt', undefined])(
    'rejects private and loopback targets when NODE_ENV is %s',
    (environment) => {
      setEnvironment(environment);

      for (const target of [
        'http://localhost:3000',
        'http://localhost.:3000',
        'http://service.internal./health',
        'http://0.0.0.0',
        'http://127.0.0.1',
        'http://10.0.0.1',
        'http://172.20.0.1',
        'http://192.168.1.1',
        'http://169.254.1.1',
        'http://100.64.0.1',
        'http://[::1]',
        'http://[fc00::1]',
        'http://[fe80::1]',
      ]) {
        expect(validateExternalUrl(target), target).toBeNull();
      }
    },
  );

  it.each(['test', 'development'])(
    'allows private and loopback targets in explicit %s mode',
    (environment) => {
      setEnvironment(environment);

      for (const target of [
        'http://localhost:3000',
        'http://localhost.:3000',
        'http://service.internal./health',
        'http://0.0.0.0',
        'http://127.0.0.1',
        'http://10.0.0.1',
        'http://192.168.1.1',
        'http://169.254.1.1',
        'http://100.64.0.1',
        'http://[::1]',
        'http://[fc00::1]',
      ]) {
        expect(validateExternalUrl(target), target).toBe(target);
      }
    },
  );

  it.each(['test', 'development', 'production', 'staging', undefined])(
    'always rejects cloud metadata targets when NODE_ENV is %s',
    (environment) => {
      setEnvironment(environment);

      expect(validateExternalUrl('http://169.254.169.254/latest/meta-data')).toBeNull();
      expect(validateExternalUrl('http://metadata.google.internal/computeMetadata/v1')).toBeNull();
      expect(validateExternalUrl('http://metadata.google.internal./computeMetadata/v1')).toBeNull();
    },
  );

  it.each(['test', 'development', 'production', 'staging', undefined])(
    'rejects malformed empty DNS labels when NODE_ENV is %s',
    (environment) => {
      setEnvironment(environment);

      for (const target of [
        'https://.example.com/path',
        'https://..example.com/path',
        'https://example..com/path',
        'http://metadata.google.internal../computeMetadata/v1',
        'https://。example.com/path',
        'https://example。。com/path',
        'https://example.com。。/path',
        'https://example．｡com/path',
      ]) {
        expect(validateExternalUrl(target), target).toBeNull();
      }
    },
  );

  it.each(['test', 'development', 'production', 'staging', undefined])(
    'allows public URLs when NODE_ENV is %s',
    (environment) => {
      setEnvironment(environment);
      for (const target of [
        'https://agent.example.com/mcp',
        'https://agent.example.com./mcp',
        'https://agent.example.com。/mcp',
        'https://agent．example｡com/mcp',
        'https://[2001:4860:4860::8888]/mcp',
      ]) {
        expect(validateExternalUrl(target), target).toBe(target);
      }
    },
  );
});
