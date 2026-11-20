export const EXTENSION_URI = "https://extensions.adcontextprotocol.org/seller-adjustable-terms";
export const EXTENSION_DIGEST = "sha256:41d05441540d02b84aafa4fa26d94094250c8337a45f3509f7c55ef7867773a9";
export const EXTENSION_VERSION = "1.6.0";
export const EXTENSION = { name: "seller-adjustable-terms", uri: EXTENSION_URI, digest: EXTENSION_DIGEST, version: EXTENSION_VERSION };
/** Package root (bundle, lock, semantic checks). A generated layer loads it through adcp.lock.json; a runtime plug-in passes this namespace to createAdcpClient({ extensions }) or server.declare(). */
export const EXTENSION_MODULE_DIR = new URL('..', import.meta.url);
/** Runtime binding: this extension's commercial_terms data, typed, or undefined. Matches this exact uri@digest only. (An app's generated layer has it as a plain attribute.) */
export function readCommercialTerms(on) {
    const t = on?.extensions?.find((x) => x.uri === EXTENSION_URI && x.digest === EXTENSION_DIGEST);
    return t ? t.data : undefined;
}
/** Runtime binding: build a commercial_terms entry for this extension (seller side). */
export function commercialTermsEntry(data) {
    return { uri: EXTENSION_URI, digest: EXTENSION_DIGEST, data };
}
/** Runtime binding: this extension's media_buy_state data, typed, or undefined. Matches this exact uri@digest only. (An app's generated layer has it as a plain attribute.) */
export function readMediaBuyState(on) {
    const t = on?.extensions_state?.find((x) => x.uri === EXTENSION_URI && x.digest === EXTENSION_DIGEST);
    return t ? t.data : undefined;
}
/** Runtime binding: build a media_buy_state entry for this extension (seller side). */
export function mediaBuyStateEntry(data) {
    return { uri: EXTENSION_URI, digest: EXTENSION_DIGEST, data };
}
