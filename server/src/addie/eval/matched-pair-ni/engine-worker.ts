/** Killable execution boundary for the non-admitting exact diagnostic. */
import { parentPort, workerData } from 'node:worker_threads';
import { nullBoundarySizeEnvelopeWorker, restrictedScoreEMWorker, type MatchedPairNiInput } from './engine.js';
import type { Rational } from './rational.js';

interface WorkerRequest {
  readonly task: 'restricted_score' | 'null_size';
  readonly payload: MatchedPairNiInput | Readonly<{ n: number; margin: Rational; alpha: Rational }>;
}

try {
  const request = workerData as WorkerRequest;
  const value = request.task === 'restricted_score'
    ? restrictedScoreEMWorker(request.payload as MatchedPairNiInput)
    : nullBoundarySizeEnvelopeWorker(
      (request.payload as { n: number }).n,
      (request.payload as { margin: Rational }).margin,
      (request.payload as { alpha: Rational }).alpha,
    );
  parentPort?.postMessage({ ok: true, value });
} catch {
  parentPort?.postMessage({ ok: false });
}
