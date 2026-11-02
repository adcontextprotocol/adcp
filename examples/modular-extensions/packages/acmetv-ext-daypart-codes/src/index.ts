/* Generated from https://ext.acmetv.example.com/adcp/daypart-codes@sha256:06d49beb19d149698a586ae63eec054e07d85c4ece866af81821b2c5931d2c40 (v2.6.0). Do not edit. */
import type { ExtensionEntry } from '@adcp/core';

export const EXTENSION_URI = "https://ext.acmetv.example.com/adcp/daypart-codes" as const;
export const EXTENSION_DIGEST = "sha256:06d49beb19d149698a586ae63eec054e07d85c4ece866af81821b2c5931d2c40" as const;
export const EXTENSION_VERSION = "2.6.0" as const;
export const EXTENSION = { name: "daypart-codes", uri: EXTENSION_URI, digest: EXTENSION_DIGEST, version: EXTENSION_VERSION } as const;
/** Package root (bundle, lock, semantic checks). A generated layer loads it through adcp.lock.json; a runtime plug-in passes this namespace to createAdcpClient({ extensions }) or server.declare(). */
export const EXTENSION_MODULE_DIR = new URL('..', import.meta.url);

/** pricing_option.extensions[] entry (must_understand: optional). */
export type DaypartCodesPricingOptionEntry = Omit<ExtensionEntry, 'uri' | 'digest' | 'data'> & {
  uri: typeof EXTENSION_URI;
  digest: typeof EXTENSION_DIGEST;
  data: DaypartCodes;
};

/** Runtime binding: this extension's pricing_option data, typed, or undefined. Matches this exact uri@digest only. (An app's generated layer has it as a plain attribute.) */
export function readPricingOption(on: { extensions?: ExtensionEntry[] | null } | null | undefined): DaypartCodes | undefined {
  const t = on?.extensions?.find((x) => x.uri === EXTENSION_URI && x.digest === EXTENSION_DIGEST);
  return t ? (t.data as DaypartCodes) : undefined;
}

/** Runtime binding: build a pricing_option entry for this extension (seller side). */
export function pricingOptionEntry(data: DaypartCodes): DaypartCodesPricingOptionEntry {
  return { uri: EXTENSION_URI, digest: EXTENSION_DIGEST, data };
}


/**
 * This interface was referenced by `DaypartCodesTypes`'s JSON-Schema
 * via the `definition` "DaypartCodes".
 */
export interface DaypartCodes {
  /**
   * @minItems 1
   */
  dayparts: [
    {
      code: string;
      end: string;
      label?: string;
      start: string;
    },
    ...{
      code: string;
      end: string;
      label?: string;
      start: string;
    }[]
  ];
}
