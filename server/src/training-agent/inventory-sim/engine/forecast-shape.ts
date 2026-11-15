/**
 * An engine forecast in AdCP's `forecast` shape (`core/delivery-forecast.json`).
 * Plain objects, no AdCP imports, so the engine stays portable.
 */
import type { ForecastResult } from './simulation.js';

export interface ForecastRange {
  low?: number;
  mid: number;
  high?: number;
}

export interface AdcpDeliveryForecast {
  points: Array<{
    budget?: number;
    metrics: Record<string, ForecastRange>;
  }>;
  forecast_range_unit: 'availability' | 'spend';
  method: 'guaranteed' | 'modeled';
  currency: string;
  generated_at: string;
  valid_until: string;
}

export function toAdcpForecast(
  result: ForecastResult,
  options: { guaranteed: boolean; budget?: number; generatedAt: string; validUntil: string },
): AdcpDeliveryForecast {
  const metrics: Record<string, ForecastRange> = {
    impressions: { low: result.low, mid: result.impressions, high: result.high },
    clicks: { mid: result.clicks },
  };
  if (result.cpm !== undefined) metrics.spend = { mid: result.spend };
  if (result.completed_views > 0) metrics.completed_views = { mid: result.completed_views };
  return {
    points: [{ ...(options.budget !== undefined && { budget: options.budget }), metrics }],
    forecast_range_unit: options.budget !== undefined ? 'spend' : 'availability',
    method: options.guaranteed ? 'guaranteed' : 'modeled',
    currency: result.currency,
    generated_at: options.generatedAt,
    valid_until: options.validUntil,
  };
}
