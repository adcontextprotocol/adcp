/**
 * The sole ordinary import boundary for paid matched-v4 execution.
 *
 * It deliberately re-exports only a plan-only view and the sealed authority
 * factory. Execution selection, response/usage recording, validation, promotion, and
 * artifact shapes stay local to the factory's custody implementation.
 */
export {
  createAddieMatchedV4PaidAuthority,
  createAddieMatchedV4PrivateAuthorityPlanOnly,
} from "./matched-v4-authority-custody.js";
