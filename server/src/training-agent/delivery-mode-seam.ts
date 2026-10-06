/**
 * TEST-ONLY delivery-mode seam for the training `sales` tenant (adcp#7852).
 *
 * The training seller normally sells BOTH delivery modes (default `both`, zero
 * behaviour change). Setting `TRAINING_SALES_DELIVERY_MODES` makes it behave
 * like a seller that only sells one mode, so the conformance suite can be
 * graded against a faithful single-mode seller:
 *
 *   guaranteed      get_products returns only guaranteed products; every
 *                   create_media_buy on guaranteed products returns the
 *                   `submitted` arm (task_id, no media_buy_id) that stays
 *                   pending until force_task_completion; non-guaranteed
 *                   products are rejected with UNSUPPORTED_FEATURE.
 *   non_guaranteed  mirror image: guaranteed buys are rejected with
 *                   UNSUPPORTED_FEATURE; no submitted arm is emitted
 *                   unless force_create_media_buy_arm asks for one.
 *   both            unchanged.
 *
 * `TRAINING_SALES_SEED_POLICY` decides what a single-mode seller does with a
 * controller-seeded product of the unsold mode:
 *   store   (default) seed succeeds but the product is hidden from
 *           get_products and cannot be bought (UNSUPPORTED_FEATURE).
 *   refuse  seed_product itself fails (INVALID_PARAMS), as a seller with no
 *           inventory of that kind would.
 *   sell    seeded products are sold per their own delivery_type regardless
 *           of the configured mode (a seller that "seeds and sells whatever
 *           the runner seeds"). Only the native catalog is mode-filtered.
 *
 * A single-mode seller declares `media_buy.supported_delivery_types` (an
 * explicit `both` declares both modes; unset declares nothing, which means
 * both). An unsold mode is rejected with UNSUPPORTED_FEATURE: the registered
 * code for a capability the seller does not offer. No delivery-mode-specific
 * error code exists in error-code.json.
 */

export type DeliveryModes = 'guaranteed' | 'non_guaranteed' | 'both';
export type SeedPolicy = 'store' | 'refuse' | 'sell';
type DeliveryType = 'guaranteed' | 'non_guaranteed';

export const UNSOLD_DELIVERY_MODE_ERROR_CODE = 'UNSUPPORTED_FEATURE';

export function configuredDeliveryModes(): DeliveryModes {
  const raw = process.env.TRAINING_SALES_DELIVERY_MODES;
  return raw === 'guaranteed' || raw === 'non_guaranteed' ? raw : 'both';
}

export function configuredSeedPolicy(): SeedPolicy {
  const raw = process.env.TRAINING_SALES_SEED_POLICY;
  return raw === 'refuse' || raw === 'sell' ? raw : 'store';
}

/** `media_buy.supported_delivery_types` to advertise; undefined when the env seam is unset. */
export function declaredDeliveryTypes(): DeliveryType[] | undefined {
  const raw = process.env.TRAINING_SALES_DELIVERY_MODES;
  if (raw === 'guaranteed') return ['guaranteed'];
  if (raw === 'non_guaranteed') return ['non_guaranteed'];
  if (raw === 'both') return ['guaranteed', 'non_guaranteed'];
  return undefined;
}

export function isSingleModeSeller(): boolean {
  return configuredDeliveryModes() !== 'both';
}

function modeSellsDeliveryType(deliveryType: unknown): boolean {
  const modes = configuredDeliveryModes();
  if (modes === 'both') return true;
  return (deliveryType === 'guaranteed' ? 'guaranteed' : 'non_guaranteed') === modes;
}

/** Whether a product may be listed/bought. `seeded` = injected by seed_product. */
export function sellerSellsProduct(
  product: { delivery_type?: unknown } | undefined,
  seeded: boolean,
): boolean {
  if (!product) return true; // unknown ids keep their existing error path
  if (seeded && configuredSeedPolicy() === 'sell') return true;
  return modeSellsDeliveryType(product.delivery_type);
}

/** seed_product refusal for a single-mode seller; undefined when accepted. */
export function seedRefusal(fixture: unknown): string | undefined {
  if (configuredSeedPolicy() !== 'refuse') return undefined;
  const deliveryType = (fixture as { delivery_type?: unknown } | undefined)?.delivery_type;
  if (deliveryType === undefined || modeSellsDeliveryType(deliveryType)) return undefined;
  return `This seller does not sell ${String(deliveryType)} inventory`;
}

/** Specialisms a single-mode seller advertises (the other mode's is dropped). */
export function specialismsForDeliveryModes<T extends string>(specialisms: readonly T[]): T[] {
  const modes = configuredDeliveryModes();
  const drop = modes === 'guaranteed'
    ? 'sales-non-guaranteed'
    : modes === 'non_guaranteed'
      ? 'sales-guaranteed'
      : undefined;
  return specialisms.filter(specialism => specialism !== drop);
}
