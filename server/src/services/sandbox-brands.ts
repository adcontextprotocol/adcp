import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import type { BrandCanonicalDocument } from '../brand-manager.js';
import { validateBrandJsonSchema } from './brand-json-schema-validator.js';

/**
 * Sandbox test brands for the fictional advertisers in the compliance test
 * kits (static/compliance/source/test-kits/*.yaml).
 *
 * Kit brands use the reserved `.example` TLD (RFC 2606). No origin can serve
 * their brand.json and no one else can own them, so AgenticAdvertising.org
 * answers for them from the kits. They are resolved, never stored, which keeps
 * them out of registry listings and search.
 *
 * A kit is included when it declares `sandbox: true` and its
 * `brand.house.domain` ends in `.example`.
 */

const TEST_KITS_DIR = join(process.cwd(), 'static', 'compliance', 'source', 'test-kits');
const RESERVED_TLD = '.example';

interface TestKitBrand {
  house?: { domain?: string };
  brand_id?: string;
  [key: string]: unknown;
}

let sandboxBrands: Map<string, BrandCanonicalDocument> | null = null;

function loadSandboxBrands(dir: string): Map<string, BrandCanonicalDocument> {
  const brands = new Map<string, BrandCanonicalDocument>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort()) {
    const kit = YAML.parse(readFileSync(join(dir, file), 'utf8')) as {
      sandbox?: boolean;
      brand?: TestKitBrand;
    };
    const domain = kit.brand?.house?.domain?.toLowerCase();
    if (kit.sandbox !== true || !domain?.endsWith(RESERVED_TLD)) continue;

    const { house: _house, brand_id: brandId, ...fields } = kit.brand!;
    const document = { id: brandId, ...fields };
    const validation = validateBrandJsonSchema(document);
    if (!validation.valid) {
      throw new Error(
        `Test kit ${file}: brand is not a valid brand.json document: ${JSON.stringify(validation.errors.slice(0, 3))}`
      );
    }
    if (brands.has(domain)) {
      throw new Error(`Test kit ${file}: sandbox brand domain ${domain} is declared by more than one kit`);
    }
    brands.set(domain, document as unknown as BrandCanonicalDocument);
  }
  return brands;
}

/** The sandbox brand for a test-kit domain, as a Brand Canonical Document. */
export function getSandboxBrand(domain: string): BrandCanonicalDocument | undefined {
  sandboxBrands ??= loadSandboxBrands(TEST_KITS_DIR);
  return sandboxBrands.get(domain.toLowerCase());
}

/** Domains of every sandbox test brand. */
export function listSandboxBrandDomains(): string[] {
  sandboxBrands ??= loadSandboxBrands(TEST_KITS_DIR);
  return [...sandboxBrands.keys()];
}
