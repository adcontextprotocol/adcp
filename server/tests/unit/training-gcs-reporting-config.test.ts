import { describe, expect, it } from 'vitest';
import { trainingGcsReportingConfig } from '../../src/training-agent/gcs-reporting-config.js';

const enabled = {
  TRAINING_REPORTING_GCS_ENABLED: 'true', TRAINING_REPORTING_GCS_BUCKET: 'adcp-training-canary',
  TRAINING_REPORTING_GCS_NAMESPACE: 'training-sales:canary-v1',
  TRAINING_REPORTING_GCS_CREDENTIALS_FILE: '/run/secrets/reporting-gcp.json',
  TRAINING_REPORTING_GCS_CANARY_PRINCIPAL: 'workos:org_canary',
  TRAINING_REPORTING_GCS_FRESH_BUCKET_ACK: 'true',
};
describe('private GCS reporting activation', () => {
  it('preserves the fixture path by default', () => {
    expect(trainingGcsReportingConfig({})).toBeUndefined();
    expect(trainingGcsReportingConfig({ ...enabled, TRAINING_REPORTING_GCS_ENABLED: 'false' })).toBeUndefined();
  });
  it('requires every provisioning commitment before activation', () => {
    for (const key of Object.keys(enabled).filter(key => key !== 'TRAINING_REPORTING_GCS_ENABLED')) {
      expect(() => trainingGcsReportingConfig({ ...enabled, [key]: '' })).toThrow();
    }
    expect(trainingGcsReportingConfig(enabled)).toEqual({ bucket: 'adcp-training-canary', namespace: 'training-sales:canary-v1', credentialsFile: '/run/secrets/reporting-gcp.json', canaryPrincipal: 'workos:org_canary' });
  });
  it.each(['anonymous', 'static:public', 'static:primary', 'static:demo:anything', 'signing:fixture', 'workos:'])('refuses a principal outside the private WorkOS canary %s', principal => {
    expect(() => trainingGcsReportingConfig({ ...enabled, TRAINING_REPORTING_GCS_CANARY_PRINCIPAL: principal })).toThrow();
  });
  it('refuses credential-shaped bucket/namespace and relative credential paths', () => {
    for (const [key, value] of [
      ['TRAINING_REPORTING_GCS_BUCKET', 'https://storage.googleapis.com/shared'],
      ['TRAINING_REPORTING_GCS_NAMESPACE', 'https://user:secret@host'],
      ['TRAINING_REPORTING_GCS_CREDENTIALS_FILE', './adc.json'],
    ]) expect(() => trainingGcsReportingConfig({ ...enabled, [key]: value })).toThrow();
  });
});
