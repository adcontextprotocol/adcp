// @adcp-ext/makegood-units: runtime half of the extension module.
//  - commercial_terms: rule ids unique and ordered, purchase_index resolves.
//  - media_buy_state:  every issued unit is inside its rule (cap, window,
//    sameness, zero cost) and points at a real core package.
//  - task request_makegood: the response answers the rule the request named.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const packageDir = path.dirname(fileURLToPath(import.meta.url));

const UNIT_MS = { seconds: 1e3, minutes: 6e4, hours: 36e5, days: 864e5 };
const durationMs = (d) => d.interval * UNIT_MS[d.unit];

function checkRules(data, purchases) {
  const errors = [];
  const ids = data.rules.map((r) => r.rule_id);
  if (new Set(ids).size !== ids.length) errors.push('rule_id values must be unique');
  if (ids.some((id, i) => i > 0 && ids[i - 1] > id)) errors.push('rules must be ordered by rule_id');
  for (const r of data.rules) {
    if (!purchases?.[r.purchase_index]) errors.push(`${r.rule_id}: purchase_index ${r.purchase_index} is outside commercial_terms.purchases`);
    if (r.window.unit === 'campaign') errors.push(`${r.rule_id}: window must be a fixed duration, not 'campaign'`);
  }
  return { errors, warnings: [] };
}

function checkTaskResponse(response, { branch, request }) {
  if (branch !== 'request_makegood') return { errors: [`makegood-units contributes no task ${branch}`], warnings: [] };
  const errors = [];
  if (request && response.rule_id !== request.rule_id) errors.push(`the response is for rule ${response.rule_id}; the request named ${request.rule_id}`);
  return { errors, warnings: [] };
}

export function check(point, data, context) {
  const { enclosing, self } = context;
  if (point === 'commercial_terms') return checkRules(data, enclosing.purchases);
  if (point === 'task') return checkTaskResponse(data, context);
  if (point !== 'media_buy_state') return { errors: [`makegood-units does not attach at ${point}`], warnings: [] };

  const accepted = enclosing.accepted_proposal?.commercial_terms;
  const entry = accepted?.extensions?.find((t) => t.uri === self.uri);
  if (!entry) return { errors: ['make-good units reported, but the accepted terms carry no make-good rules'], warnings: [] };
  const rules = new Map(entry.data.rules.map((r) => [r.rule_id, r]));
  const packages = new Map((enclosing.packages ?? []).map((p) => [p.package_id, p]));
  const used = new Map();
  const violations = [];
  for (const mg of data.issued) {
    const at = `${mg.makegood_id} (rule ${mg.rule_id})`;
    const rule = rules.get(mg.rule_id);
    if (!rule) {
      violations.push(`${at}: rule is not in the accepted terms`);
      continue;
    }
    used.set(rule.rule_id, (used.get(rule.rule_id) ?? 0) + 1);
    if (used.get(rule.rule_id) > rule.max_units) violations.push(`${at}: unit ${used.get(rule.rule_id)} exceeds max_units ${rule.max_units}`);
    if (mg.reason !== rule.trigger) violations.push(`${at}: reason ${mg.reason} does not match the rule trigger ${rule.trigger}`);
    for (const attr of rule.keep_same) {
      const e = mg.evidence[attr];
      if (!e) violations.push(`${at}: no evidence for keep_same ${attr}`);
      else if (e.original !== e.makegood) violations.push(`${at}: ${attr} changed (${e.original} -> ${e.makegood}); the rule keeps it the same`);
    }
    const pkg = packages.get(mg.package_id);
    if (!pkg) {
      violations.push(`${at}: package ${mg.package_id} is not in this media buy`);
      continue;
    }
    if (pkg.budget !== 0) violations.push(`${at}: package ${mg.package_id} has budget ${pkg.budget}; make-good units are zero-cost`);
    const latest = Date.parse(accepted.purchases[rule.purchase_index].end_time) + durationMs(rule.window);
    if (pkg.start_time && Date.parse(pkg.start_time) > latest) {
      violations.push(`${at}: starts ${pkg.start_time}, after the ${rule.window.interval}-${rule.window.unit} window`);
    }
  }
  return { errors: [], warnings: [], violations };
}
