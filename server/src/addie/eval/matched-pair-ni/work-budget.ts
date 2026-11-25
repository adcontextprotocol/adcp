/** Default wall-clock deadline for one worker computation, checked at work-budget charges. */
export const MATCHED_PAIR_NI_MAX_WORK_MILLISECONDS = 12_000;

/**
 * The E-step work budget of one worker computation: a deterministic unit
 * limit and, unless the caller passes `null`, a wall-clock deadline from
 * construction. Either one ends the computation with the ceiling RangeError,
 * which the engine reports as `complexity_ceiling`. `now` is injectable so the
 * deadline can be tested on a fake clock.
 */
export class WorkBudget {
  private used = 0;
  private readonly limit: number;
  private readonly deadline: number | null;
  private readonly now: () => number;
  constructor(limit: number, deadlineMilliseconds: number | null = MATCHED_PAIR_NI_MAX_WORK_MILLISECONDS, now: () => number = () => Date.now()) {
    this.limit = limit;
    this.now = now;
    this.deadline = deadlineMilliseconds === null ? null : now() + deadlineMilliseconds;
  }
  charge(units = 1): void {
    this.used += units;
    if (this.used > this.limit || (this.deadline !== null && this.now() > this.deadline)) throw new RangeError('Exact E+M aggregate work ceiling exceeded');
  }
}
