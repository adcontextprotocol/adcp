import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type PromotedFormatShape = {
  promoted_to: string;
  promotion_release: string;
  promotion_start: string;
  transition_end: string;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REGISTRY_PATH = process.env.NODE_ENV === 'production'
  ? path.join(__dirname, '../../static/schemas/source/core/format-shape-vocabulary.json')
  : path.join(__dirname, '../../../static/schemas/source/core/format-shape-vocabulary.json');

let cached: Readonly<Record<string, PromotedFormatShape>> | undefined;

export function getPromotedFormatShapes(): Readonly<Record<string, PromotedFormatShape>> {
  if (cached) return cached;
  const parsed = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as {
    vocabulary?: Record<string, Partial<PromotedFormatShape>>;
  };
  const promoted: Record<string, PromotedFormatShape> = {};
  for (const [shape, entry] of Object.entries(parsed.vocabulary ?? {})) {
    if (
      typeof entry.promoted_to === 'string'
      && typeof entry.promotion_release === 'string'
      && typeof entry.promotion_start === 'string'
      && typeof entry.transition_end === 'string'
    ) {
      promoted[shape] = entry as PromotedFormatShape;
    }
  }
  cached = Object.freeze(promoted);
  return cached;
}
