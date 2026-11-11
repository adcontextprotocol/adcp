import { afterEach, describe, expect, it } from 'vitest';
import { getIdentityBaseUrl, TRAINING_AGENT_URL } from '../../src/training-agent/config.js';

const saved = { agent: process.env.TRAINING_AGENT_URL, identity: process.env.TRAINING_AGENT_IDENTITY_URL };
afterEach(() => {
  for (const [key, value] of [['TRAINING_AGENT_URL', saved.agent], ['TRAINING_AGENT_IDENTITY_URL', saved.identity]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('getIdentityBaseUrl', () => {
  it('follows the agent URL by default', () => {
    delete process.env.TRAINING_AGENT_IDENTITY_URL;
    process.env.TRAINING_AGENT_URL = 'http://127.0.0.1:4000/api/training-agent/';
    expect(getIdentityBaseUrl()).toBe('http://127.0.0.1:4000/api/training-agent');
    delete process.env.TRAINING_AGENT_URL;
    expect(getIdentityBaseUrl()).toBe(TRAINING_AGENT_URL);
  });

  it('lets the storyboard runner keep an https identity across its loopback swap', () => {
    process.env.TRAINING_AGENT_URL = 'http://127.0.0.1:4000/api/training-agent';
    process.env.TRAINING_AGENT_IDENTITY_URL = `${TRAINING_AGENT_URL}/`;
    expect(getIdentityBaseUrl()).toBe(TRAINING_AGENT_URL);
  });
});
