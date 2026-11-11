export const EXTENSION_URI = "https://extensions.adcontextprotocol.org/makegood-units";
export const EXTENSION_DIGEST = "sha256:0debf79a73907c27500528c005c03948e3256a1128e2e74b25d58c7b6ac93bd4";
export const EXTENSION_VERSION = "1.5.0";
export const EXTENSION = { name: "makegood-units", uri: EXTENSION_URI, digest: EXTENSION_DIGEST, version: EXTENSION_VERSION };
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
/** Task id of `request_makegood`: a branch of the task union (no digest). Seller capabilities map a transport name to it. */
export const REQUEST_MAKEGOOD = "https://extensions.adcontextprotocol.org/makegood-units#request_makegood";
/**
 * Tasks this extension contributes. An app's generated layer turns each into a typed client method
 * (client.<task>(request)) and a typed handler (server.handle('<task>', handler)). Runtime binding:
 * client.ext(module).<task>(request) and server.handle(module.tasks.<task>, handler).
 */
export const tasks = {
    /** The buyer asks the seller to issue a make-good unit under an accepted rule for a missed deliverable. The seller answers accepted, with the zero-cost package that carries the unit, or rejected, with a reason. */
    requestMakegood: {
        id: REQUEST_MAKEGOOD,
        uri: EXTENSION_URI,
        digest: EXTENSION_DIGEST,
        branch: "request_makegood",
        request: "MakegoodRequest",
        response: "MakegoodResponse",
    },
};
