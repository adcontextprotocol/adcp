export const EXTENSION_URI = "https://ext.acmetv.example.com/adcp/daypart-codes";
export const EXTENSION_DIGEST = "sha256:06d49beb19d149698a586ae63eec054e07d85c4ece866af81821b2c5931d2c40";
export const EXTENSION_VERSION = "2.6.0";
export const EXTENSION = { name: "daypart-codes", uri: EXTENSION_URI, digest: EXTENSION_DIGEST, version: EXTENSION_VERSION };
/** Package root (bundle, lock, semantic checks). A generated layer loads it through adcp.lock.json; a runtime plug-in passes this namespace to createAdcpClient({ extensions }) or server.declare(). */
export const EXTENSION_MODULE_DIR = new URL('..', import.meta.url);
/** Runtime binding: this extension's pricing_option data, typed, or undefined. Matches this exact uri@digest only. (An app's generated layer has it as a plain attribute.) */
export function readPricingOption(on) {
    const t = on?.extensions?.find((x) => x.uri === EXTENSION_URI && x.digest === EXTENSION_DIGEST);
    return t ? t.data : undefined;
}
/** Runtime binding: build a pricing_option entry for this extension (seller side). */
export function pricingOptionEntry(data) {
    return { uri: EXTENSION_URI, digest: EXTENSION_DIGEST, data };
}
