/** Reporting has its own identity and isolated schema on the application primary. */
export const TRAINING_REPORTING_SCHEMA = 'training_reporting_gcs';
export const TRAINING_REPORTING_LIMITS = {
  recoverySeconds: 7_200,
  statusRetentionDays: 31,
  resourceRetentionDays: 31,
  revocationSeconds: 300,
  operationMilliseconds: 30_000,
  resourceBytes: 4 * 1024 * 1024,
} as const;

export interface TrainingGcsReportingConfig {
  bucket: string;
  namespace: string;
  credentialsFile: string;
  canaryPrincipal: string;
}

export function trainingGcsReportingConfig(env: NodeJS.ProcessEnv = process.env): TrainingGcsReportingConfig | undefined {
  if (env.TRAINING_REPORTING_GCS_ENABLED !== 'true') return undefined;
  const bucket = env.TRAINING_REPORTING_GCS_BUCKET;
  const namespace = env.TRAINING_REPORTING_GCS_NAMESPACE;
  const credentialsFile = env.TRAINING_REPORTING_GCS_CREDENTIALS_FILE;
  const canaryPrincipal = env.TRAINING_REPORTING_GCS_CANARY_PRINCIPAL;
  if (!bucket || !/^[a-z0-9][a-z0-9.-]{2,62}$/.test(bucket)
    || !namespace || !/^[a-z][a-z0-9_.:-]{0,127}$/.test(namespace)
    || !credentialsFile?.startsWith('/') || !canaryPrincipal
    || !/^workos:.+$/.test(canaryPrincipal)
    || env.TRAINING_REPORTING_GCS_FRESH_BUCKET_ACK !== 'true') {
    throw new Error('GCS reporting requires a dedicated fresh bucket, stable namespace, dedicated credential file and private canary principal.');
  }
  return { bucket, namespace, credentialsFile, canaryPrincipal };
}
