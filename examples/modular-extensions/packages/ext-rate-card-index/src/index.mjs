export const EXTENSION_URI = "https://extensions.adcontextprotocol.org/rate-card-index";
export const EXTENSION_DIGEST = "sha256:a24ab2ac5282278300002b0fd40b8f2bd625f8197ef6fc4130e06fb417d4d580";
export const EXTENSION_VERSION = "1.5.0";
export const EXTENSION = { name: "rate-card-index", uri: EXTENSION_URI, digest: EXTENSION_DIGEST, version: EXTENSION_VERSION };
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
/** Runtime binding: this extension's commercial_terms data, typed, or undefined. Matches this exact uri@digest only. (An app's generated layer has it as a plain attribute.) */
export function readCommercialTerms(on) {
    const t = on?.extensions?.find((x) => x.uri === EXTENSION_URI && x.digest === EXTENSION_DIGEST);
    return t ? t.data : undefined;
}
/** Runtime binding: build a commercial_terms entry for this extension (seller side). */
export function commercialTermsEntry(data) {
    return { uri: EXTENSION_URI, digest: EXTENSION_DIGEST, data };
}
