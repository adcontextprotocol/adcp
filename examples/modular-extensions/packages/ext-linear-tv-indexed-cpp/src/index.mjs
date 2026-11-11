export const EXTENSION_URI = "https://extensions.adcontextprotocol.org/linear-tv-indexed-cpp";
export const EXTENSION_DIGEST = "sha256:52f80ee6d7a35c6a803f3967c13ab7005d60d1857993437e608caab0ddde2bd1";
export const EXTENSION_VERSION = "1.5.0";
export const EXTENSION = { name: "linear-tv-indexed-cpp", uri: EXTENSION_URI, digest: EXTENSION_DIGEST, version: EXTENSION_VERSION };
/** Package root (bundle, lock, semantic checks). A generated layer loads it through adcp.lock.json; a runtime plug-in passes this namespace to createAdcpClient({ extensions }) or server.declare(). */
export const EXTENSION_MODULE_DIR = new URL('..', import.meta.url);
/** Branch id of pricing_model branch `indexed_cpp`: the discriminator value (no digest). */
export const INDEXED_CPP = "https://extensions.adcontextprotocol.org/linear-tv-indexed-cpp#indexed_cpp";
/** Runtime binding: this branch's data, typed, or undefined. Matches this exact uri@digest only. (An app's generated layer has it as a plain attribute.) */
export function readIndexedCpp(on) {
    const t = on?.pricing_model === INDEXED_CPP ? on.extension_model : undefined;
    return t && t.uri === EXTENSION_URI && t.digest === EXTENSION_DIGEST ? t.data : undefined;
}
/** Runtime binding: build the branch's discriminator and body (seller side). */
export function indexedCppBranch(data) {
    return { pricing_model: INDEXED_CPP, extension_model: { uri: EXTENSION_URI, digest: EXTENSION_DIGEST, data } };
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
/** capabilities: this extension's fragment in a declaration (must_understand: optional). */
export function readCapabilities(on) {
    return on && on.uri === EXTENSION_URI && on.digest === EXTENSION_DIGEST ? on.capabilities : undefined;
}
/** Type-check this extension's capabilities fragment (seller side); pass it to server.declare(module, { capabilities }). */
export function capabilitiesFragment(data) {
    return data;
}
