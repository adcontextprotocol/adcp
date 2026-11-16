/**
 * One day's allocation of actual impressions to bookings. Pure functions over
 * a map of cell → impressions still unsold; each call subtracts what it hands
 * out. Impressions are whole numbers.
 */

/** Cell slot index → impressions. */
export type CellCounts = Map<number, number>;

const EPSILON = 1e-9;

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Unsold impressions across the given cells. */
export function supplyOf(remaining: CellCounts, cells: readonly number[]): number {
  let total = 0;
  for (const cell of cells) total += remaining.get(cell) ?? 0;
  return total;
}

/**
 * Take `want` impressions as the same share of every cell: the smallest share
 * that reaches `want`, or everything when the cells cannot cover it. Whole
 * impressions left over after rounding down go to the cells with the largest
 * remainders, ties to the lower slot index, so the total is exactly
 * min(want, supply) and no cell gives more than it has.
 */
export function takeEqualShare(remaining: CellCounts, cells: readonly number[], want: number): CellCounts {
  const taken: CellCounts = new Map();
  const target = Math.max(0, Math.floor(want));
  const supply = supplyOf(remaining, cells);
  if (target === 0 || supply === 0) return taken;
  const ordered = [...new Set(cells)].sort((a, b) => a - b);
  if (target >= supply) {
    for (const cell of ordered) {
      const available = remaining.get(cell) ?? 0;
      if (available > 0) {
        taken.set(cell, available);
        remaining.set(cell, 0);
      }
    }
    return taken;
  }
  const share = target / supply;
  let assigned = 0;
  const fractions: Array<{ cell: number; fraction: number }> = [];
  for (const cell of ordered) {
    const available = remaining.get(cell) ?? 0;
    if (available === 0) continue;
    const raw = share * available;
    const whole = Math.min(available, Math.floor(raw + EPSILON));
    if (whole > 0) taken.set(cell, whole);
    assigned += whole;
    if (whole < available) fractions.push({ cell, fraction: raw - whole });
  }
  fractions.sort((a, b) => b.fraction - a.fraction || a.cell - b.cell);
  for (let i = 0; assigned < target && i < fractions.length; i++) {
    const { cell } = fractions[i];
    taken.set(cell, (taken.get(cell) ?? 0) + 1);
    assigned += 1;
  }
  for (const [cell, count] of taken) remaining.set(cell, (remaining.get(cell) ?? 0) - count);
  return taken;
}

/**
 * Share-of-voice: take `share` of each cell's actual impressions, or what is
 * left of it if an earlier share-of-voice booking took part.
 */
export function takeShareOfVoice(
  remaining: CellCounts,
  actual: CellCounts,
  cells: readonly number[],
  share: number,
): CellCounts {
  const taken: CellCounts = new Map();
  for (const cell of [...new Set(cells)].sort((a, b) => a - b)) {
    const available = remaining.get(cell) ?? 0;
    const want = Math.floor(share * (actual.get(cell) ?? 0) + EPSILON);
    const count = Math.min(available, want);
    if (count > 0) {
      taken.set(cell, count);
      remaining.set(cell, available - count);
    }
  }
  return taken;
}

export interface GoalRequest {
  id: string;
  cells: readonly number[];
  /** The most this booking takes today. */
  target: number;
}

/**
 * High-water mark allocation. Bookings are served in order of the supply
 * they could use across all their cells, smallest first, ties by id. Each
 * takes the same share of every cell it can use from what earlier bookings
 * left: the smallest share that meets its target, or everything left when
 * its cells cannot cover it. No booking gets more than its target.
 */
export function allocateHighWaterMark(remaining: CellCounts, requests: readonly GoalRequest[]): Map<string, CellCounts> {
  const ordered = requests
    .map(request => ({ request, supply: supplyOf(remaining, request.cells) }))
    .sort((a, b) => a.supply - b.supply || compareIds(a.request.id, b.request.id));
  const result = new Map<string, CellCounts>();
  for (const { request } of ordered) {
    result.set(request.id, takeEqualShare(remaining, request.cells, request.target));
  }
  return result;
}

export interface BidRequest {
  id: string;
  cells: readonly number[];
  bid_cpm: number;
  daily_budget: number;
}

/**
 * First-price allocation of what guaranteed bookings left. Highest bid first,
 * ties by id; a bid takes only cells whose floor it meets, spread as an equal
 * share, until its daily budget is spent.
 */
export function allocateAuction(
  remaining: CellCounts,
  requests: readonly BidRequest[],
  floorOf: (cell: number) => number,
): Map<string, CellCounts> {
  const ordered = [...requests].sort((a, b) => b.bid_cpm - a.bid_cpm || compareIds(a.id, b.id));
  const result = new Map<string, CellCounts>();
  for (const request of ordered) {
    if (request.bid_cpm <= 0 || request.daily_budget <= 0) {
      result.set(request.id, new Map());
      continue;
    }
    const eligible = request.cells.filter(cell => request.bid_cpm + EPSILON >= floorOf(cell));
    const affordable = Math.floor((request.daily_budget * 1000) / request.bid_cpm + EPSILON);
    result.set(request.id, takeEqualShare(remaining, eligible, affordable));
  }
  return result;
}
