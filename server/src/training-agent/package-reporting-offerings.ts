/**
 * A media-buy package's reporting delivery offerings (3.3,
 * `packages[].reporting_delivery_offering_ids` on get_media_buys): the
 * snapshot taken when the package was confirmed, else its product's list.
 * Shared by get_media_buys and reporting-subscription coverage so both read
 * the same values.
 */
import { buildCatalog } from './product-factory.js';
import type { MediaBuyState, PackageState } from './types.js';

let productOfferings: Map<string, string[]> | undefined;

/** A package's offerings: the snapshot taken at confirmation, else its product's list. */
export function packageReportingOfferingIds(
  mediaBuy: Pick<MediaBuyState, 'reportingOfferingIdsByPackage'>,
  pkg: Pick<PackageState, 'packageId' | 'productId'>,
  products?: Map<string, { reporting_capabilities?: unknown }>,
): string[] {
  const snapshot = mediaBuy.reportingOfferingIdsByPackage?.[pkg.packageId];
  if (snapshot) return [...snapshot];
  const fromProducts = products?.get(pkg.productId)?.reporting_capabilities as { reporting_delivery_offering_ids?: string[] } | undefined;
  if (fromProducts?.reporting_delivery_offering_ids) return [...fromProducts.reporting_delivery_offering_ids];
  productOfferings ??= new Map(buildCatalog().map(entry => [
    entry.product.product_id,
    [...((entry.product.reporting_capabilities as { reporting_delivery_offering_ids?: string[] } | undefined)
      ?.reporting_delivery_offering_ids ?? [])],
  ]));
  return [...(productOfferings.get(pkg.productId) ?? [])];
}

