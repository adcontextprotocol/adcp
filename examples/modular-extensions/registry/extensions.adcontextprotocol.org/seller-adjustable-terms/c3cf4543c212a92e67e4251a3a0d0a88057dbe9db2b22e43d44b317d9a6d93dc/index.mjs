// @adcp-ext/seller-adjustable-terms: runtime half of the extension module.
//  - commercial_terms: the #8102 verifier_constraints JSON Schema cannot express.
//  - media_buy_state:  re-checks every applied adjustment against the accepted
//    allowance, so the buyer does not have to trust the seller's readback.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const packageDir = path.dirname(fileURLToPath(import.meta.url));

const UNIT_MS = { seconds: 1e3, minutes: 6e4, hours: 36e5, days: 864e5 };
const durationMs = (d) => (d ? d.interval * UNIT_MS[d.unit] : 0);

function resolvePointer(doc, pointer) {
  let node = doc;
  for (const raw of pointer.split('/').slice(1)) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (node === null || typeof node !== 'object' || !(key in node)) return { found: false };
    node = node[key];
  }
  return { found: true, value: node };
}

function checkAllowances(data, purchases) {
  const errors = [];
  const warnings = [];
  const ids = data.allowances.map((a) => a.allowance_id);
  if (new Set(ids).size !== ids.length) errors.push('allowance_id values must be unique');
  if (ids.some((id, i) => i > 0 && ids[i - 1] > id)) errors.push('allowances must be ordered by allowance_id (canonical_order)');

  const seen = new Set();
  for (const a of data.allowances) {
    const purchase = purchases?.[a.purchase_index];
    if (!purchase) {
      errors.push(`${a.allowance_id}: purchase_index ${a.purchase_index} is outside commercial_terms.purchases`);
      continue;
    }
    const key = `${a.purchase_index} ${a.path}`;
    if (seen.has(key)) errors.push(`${a.allowance_id}: second allowance on purchase ${a.purchase_index} ${a.path}`);
    seen.add(key);
    if (!resolvePointer(purchase, a.path).found) {
      errors.push(`${a.allowance_id}: ${a.path} does not resolve in purchase ${a.purchase_index} (path resolves_in_purchase_at_acceptance)`);
    }
    if (a.constraint.kind === 'time_shift' && a.path === '/start_time' && a.constraint.direction !== 'later') {
      warnings.push(`${a.allowance_id}: start_time may move earlier; check that the flight stays inside commercial_terms`);
    }
  }
  return { errors, warnings };
}

/** Is one applied change inside its allowance? Bounds count from the value in the accepted terms. */
function violationsOf(change, allowance, accepted) {
  const v = [];
  const at = `${change.adjustment_id} (allowance ${change.allowance_id})`;
  if (change.path !== allowance.path || change.purchase_index !== allowance.purchase_index) {
    return [`${at}: changed purchase ${change.purchase_index} ${change.path}, allowance covers purchase ${allowance.purchase_index} ${allowance.path}`];
  }
  const original = resolvePointer(accepted.purchases[allowance.purchase_index], allowance.path).value;
  const c = allowance.constraint;
  if (c.kind === 'time_shift') {
    const moved = Date.parse(change.value) - Date.parse(original);
    if (c.direction === 'later' && moved < 0) v.push(`${at}: moved earlier; allowance is later-only`);
    if (c.direction === 'earlier' && moved > 0) v.push(`${at}: moved later; allowance is earlier-only`);
    if (Math.abs(moved) > durationMs(c.max_shift)) {
      v.push(`${at}: moved ${Math.round(Math.abs(moved) / 864e5 * 10) / 10} days from the accepted value; allowance max is ${c.max_shift.interval} ${c.max_shift.unit}`);
    }
  } else if (c.kind === 'decrease') {
    if (!(change.value < change.previous_value)) v.push(`${at}: not a decrease`);
    if (c.min !== undefined && change.value < c.min) v.push(`${at}: below the allowance minimum ${c.min}`);
    if (c.max_change_fraction !== undefined && (original - change.value) / original > c.max_change_fraction + 1e-9) {
      v.push(`${at}: cumulative decrease ${(original - change.value) / original} exceeds ${c.max_change_fraction}`);
    }
  } else if (c.kind === 'alternates') {
    if (!c.alternates.some((alt) => JSON.stringify(alt.value) === JSON.stringify(change.value))) v.push(`${at}: value is not one of the agreed alternates`);
  }
  if (allowance.min_notice && Date.parse(change.applied_at) + durationMs(allowance.min_notice) > Date.parse(change.previous_value)) {
    if (allowance.path === '/start_time' || allowance.path === '/end_time') {
      v.push(`${at}: applied with less than ${allowance.min_notice.interval} ${allowance.min_notice.unit} notice`);
    }
  }
  return v;
}

export function check(point, data, { enclosing, self }) {
  if (point === 'commercial_terms') return checkAllowances(data, enclosing.purchases);
  if (point !== 'media_buy_state') return { errors: [`seller-adjustable-terms does not attach at ${point}`], warnings: [] };

  // Readback: find the accepted allowances this buy is running under.
  const accepted = enclosing.accepted_proposal?.commercial_terms;
  const entry = accepted?.extensions?.find((t) => t.uri === self.uri);
  if (!entry) return { errors: ['applied adjustments reported, but the accepted terms carry no allowances'], warnings: [] };
  const byId = new Map(entry.data.allowances.map((a) => [a.allowance_id, a]));
  const violations = [];
  for (const change of data.applied) {
    const allowance = byId.get(change.allowance_id);
    if (!allowance) violations.push(`${change.adjustment_id}: allowance ${change.allowance_id} is not in the accepted terms`);
    else violations.push(...violationsOf(change, allowance, accepted));
  }
  violations.push(...unpairedShifts(data.applied, entry.data.allowances));
  return { errors: [], warnings: [], violations };
}

/**
 * Start and end move in one revision (PR #8102 review): when a purchase has allowances on both
 * /start_time and /end_time, a revision that moves one of them moves the other too.
 */
function unpairedShifts(applied, allowances) {
  const TIME = ['/start_time', '/end_time'];
  const paired = new Set(
    [...new Set(allowances.map((a) => a.purchase_index))].filter((i) => TIME.every((p) => allowances.some((a) => a.purchase_index === i && a.path === p)))
  );
  const byRevision = new Map();
  for (const c of applied) {
    if (!TIME.includes(c.path) || !paired.has(c.purchase_index)) continue;
    const key = `${c.revision} ${c.purchase_index}`;
    byRevision.set(key, [...(byRevision.get(key) ?? []), c]);
  }
  const out = [];
  for (const changes of byRevision.values()) {
    const moved = new Set(changes.map((c) => c.path));
    if (moved.size === 1) {
      const [c] = changes;
      const other = TIME.find((p) => p !== c.path);
      out.push(`${c.adjustment_id} (allowance ${c.allowance_id}): revision ${c.revision} moves ${c.path} of purchase ${c.purchase_index} without ${other}; start and end move in one revision`);
    }
  }
  return out;
}
