/**
 * Public, declarative matched-v4 surface.
 *
 * It intentionally exports only the fixed plan and descriptive types.  The
 * selector, execution receipt, artifact, validation, and promotion machinery
 * live in the sealed authority custody implementation and are imported only by the private
 * authority.  Keeping those capabilities out of this ordinary module means a
 * caller cannot turn fabricated passes, usage, identities, or receipts into a
 * screening/full artifact.
 */
export {
  ADDIE_MATCHED_V4_BASELINE_CELL_IDS,
  ADDIE_MATCHED_V4_EVALUATION_VERSION,
  ADDIE_MATCHED_V4_FULL_PACK,
  ADDIE_MATCHED_V4_SCREENING_CELLS,
  ADDIE_MATCHED_V4_SCREENING_PACK,
  ADDIE_MATCHED_V4_SYNTHETIC_ISSUE_NUMBER,
  ADDIE_MATCHED_V4_SYNTHETIC_ISSUE_URL,
  ADDIE_MATCHED_V4_TOOL_SURFACES,
  addieMatchedV4ToolSurface,
  createAddieMatchedV4Plan,
} from "./matched-v4-plan.js";
export type {
  AddieMatchedV4Cell,
  AddieMatchedV4CellId,
  AddieMatchedV4Plan,
  AddieMatchedV4ReasoningEffort,
  AddieMatchedV4SyntheticTrace,
  AddieMatchedV4ToolSurface,
  AddieMatchedV4ToolSurfaceManifest,
} from "./matched-v4-plan.js";
