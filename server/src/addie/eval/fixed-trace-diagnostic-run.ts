import {
  runFixedTraceSuite,
  type FixedTraceRunnerConfig,
} from './fixed-trace-runner.js';
import { summarizeFixedTraceRun } from './fixed-trace-suite.js';

/**
 * The manual diagnostic entrypoint must execute a complete suite through the
 * guarded wrapper. In particular, this preserves its post-finalization
 * identity check before any summary/artifact can be constructed.
 */
export async function runFixedTraceDiagnosticCandidate(
  config: FixedTraceRunnerConfig,
) {
  const observations = await runFixedTraceSuite(config);
  return {
    ...summarizeFixedTraceRun(observations, config.traceSuite),
    observations,
  };
}
