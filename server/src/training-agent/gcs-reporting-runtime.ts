import type { TrainingGcsReporting } from './gcs-reporting.js';

/**
 * The durable GCS reporting runtime, exactly as getTrainingGcsReporting()
 * returns it, loaded on the first reporting request instead of at import.
 * gcs-reporting.ts loads pg, @google-cloud/storage and
 * @adcp/reporting-storage, which building the training-agent router does not
 * use; the reporting routes and tools reach it only inside their handlers.
 * server/src/http.ts still imports it statically, so production boot
 * initializes the runtime (and fails fast) as before.
 */
export async function loadTrainingGcsReporting(): Promise<TrainingGcsReporting | undefined> {
  const { getTrainingGcsReporting } = await import('./gcs-reporting.js');
  return getTrainingGcsReporting();
}
