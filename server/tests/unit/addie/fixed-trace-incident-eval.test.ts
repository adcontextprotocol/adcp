import { describe, expect, it } from 'vitest';
import {
  FIXED_TRACE_INCIDENT_EVAL_VERSION,
  runFixedTraceIncidentEval,
} from '../../../src/addie/eval/fixed-trace-incident-eval.js';

describe('fixed trace long-form incident evaluation', () => {
  it('reports complete no-network long-input, delivery, and provider-parity evidence', async () => {
    const artifact = await runFixedTraceIncidentEval();

    expect(artifact).toMatchObject({
      artifactVersion: FIXED_TRACE_INCIDENT_EVAL_VERSION,
      traceSuiteVersion: 'addie-fixed-traces-v10',
      traceId: 'long-form-deck-delivery',
      noNetwork: true,
      passed: true,
      dimensions: {
        inputAboveLegacyBoundary: true,
        inputWithinCurrentBoundary: true,
        inputPreservedBySanitizer: true,
        latePromptCoverage: true,
        retainedCoverage: true,
        retainedLength: true,
        markdownBoundary: true,
        jsonStreamParity: true,
        providerParity: true,
        slackDeliveryIntegrity: true,
      },
    });
    expect(artifact.traceSuiteSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(artifact.fixtureSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(artifact.deliveries).toHaveLength(2);
    expect(artifact.slackDelivery).toMatchObject({
      postCount: 1,
      persistedCount: 1,
      postedTextSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      persistedTextSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    for (const delivery of artifact.deliveries) {
      expect(delivery.json.outputLength).toBeGreaterThanOrEqual(9_500);
      expect(delivery.json.providerRequestSha256).toMatch(/^[a-f0-9]{64}$/);
      if (delivery.provider === 'anthropic') {
        expect(delivery.stream).not.toBeNull();
        expect(delivery.stream?.outputLength).toBe(delivery.json.outputLength);
        expect(delivery.stream?.outputSha256).toBe(delivery.json.outputSha256);
        expect(delivery.stream?.providerRequestSha256).toMatch(/^[a-f0-9]{64}$/);
      } else {
        expect(delivery.stream).toBeNull();
      }
    }
  });
});
