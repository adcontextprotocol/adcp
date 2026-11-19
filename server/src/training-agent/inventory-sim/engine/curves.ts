/**
 * How an installment's audience builds up after it is published: newsletter
 * opens over 3 days, podcast listens over 30, video views over 6 weeks.
 * Weight k is the share of the audience that arrives k days after
 * publication. Each curve sums to 1.
 */
import type { InstallmentChannel } from './types.js';

function geometric(days: number, decay: number): number[] {
  const weights: number[] = [];
  let weight = 1;
  for (let k = 0; k < days; k++) {
    weights.push(weight);
    weight *= decay;
  }
  const total = weights.reduce((sum, value) => sum + value, 0);
  return weights.map(value => value / total);
}

const CURVES: Record<InstallmentChannel, readonly number[]> = {
  newsletter: Object.freeze([0.62, 0.28, 0.1]),
  podcast: Object.freeze(geometric(30, 0.85)),
  creator_video: Object.freeze(geometric(42, 0.92)),
};

export function audienceCurve(channel: InstallmentChannel): readonly number[] {
  return CURVES[channel];
}
