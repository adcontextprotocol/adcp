/**
 * Credential-free dry-run of the real sealed matrix runner. It deliberately
 * does not provide an execution bridge, so it cannot construct a provider or
 * dispatch a model call.
 */
import {
  ADDIE_MATCHED_V4_SCREENING_PACK,
  createAddieMatchedV4Plan,
} from '../../src/addie/eval/matched-v4-evaluation.js';

const plan = createAddieMatchedV4Plan();
console.log(JSON.stringify({
  mode: 'dry_run_no_execution_bridge',
  executionAuthority: plan.executionAuthority,
  screeningPackSha256: plan.screening.packSha256,
  screeningCells: plan.screening.cells.length,
  screeningAssignments: plan.screening.cells.length * ADDIE_MATCHED_V4_SCREENING_PACK.length,
  maxProviderDispatches: plan.screening.maxProviderDispatches,
}, null, 2));
