/**
 * Deterministic inventory delivery engine (adcontextprotocol/adcp#9025).
 *
 * Self-contained: nothing here imports from the rest of the training agent,
 * so the folder can move into `@adcp/sdk` unchanged.
 */
export * from './types.js';
export { EngineError, type EngineErrorCode } from './errors.js';
export { DAY_MS, SeasonCalendar, parseDate } from './calendar.js';
export { audienceCurve } from './curves.js';
export { hash32, uniform, standardNormal } from './rng.js';
export {
  allocateAuction,
  allocateHighWaterMark,
  supplyOf,
  takeEqualShare,
  takeShareOfVoice,
  type BidRequest,
  type CellCounts,
  type GoalRequest,
} from './allocation.js';
export {
  SeasonTraffic,
  trafficFor,
  isInstallmentChannel,
  forecastErrorProblems,
  MAX_REVISION_DRAWS,
  MAX_SPIKES_PER_PUBLISHER,
  type DayTables,
  type SeedProblem,
} from './traffic.js';
export {
  InventorySimulation,
  type BookRequest,
  type BookingPatch,
  type DeliveryReport,
  type ForecastQuery,
  type ForecastResult,
  type InstallmentState,
  type InstallmentStatus,
} from './simulation.js';
export { toAdcpForecast, type AdcpDeliveryForecast, type ForecastRange } from './forecast-shape.js';
export { ENGINE_VERSION } from './version.js';
export { ADSERVER_SEASON } from './seeds/adserver-season.js';
export { CONTENT_SEASON } from './seeds/content-season.js';
