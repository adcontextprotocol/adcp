// Canonicalize a `publisher_domain` value for comparison.
//
// Used wherever code compares `publisher_domain` strings from adagents.json
// against each other — writer (publisher-db), runtime authorization gate
// (adagents-manager.hasExplicitPublisherScope), selector resolution
// (validator.selectorTargetsDomain). Before this helper existed, the writer
// used plain `.toLowerCase()` while the validator's `normalizeDomain` also
// stripped scheme prefixes and trailing slashes. A manifest with
// `selector.publisher_domain: "https://cnn.com"` matched in the validator
// but failed cross-publisher refusal in the writer; manifests with trailing
// dots or whitespace varied similarly. Catalog projection and live
// validation could then disagree on whether two strings refer to the same
// publisher.
//
// Scope: lowercases, trims whitespace, strips an `http(s)://` scheme prefix,
// strips trailing slashes, strips trailing dots (DNS-canonical form). Does
// NOT do SSRF rejection (localhost/IP refusal) — that concern belongs with
// URL-bearing input the validator separately defends against in
// `normalizeDomain`. Does NOT do IDN/punycode conversion — the schema
// pattern rejects non-ASCII today; revisit if that changes.
export function canonicalizePublisherDomain(raw: string): string {
  let v = raw.trim().toLowerCase();
  if (v.startsWith('https://')) v = v.slice(8);
  else if (v.startsWith('http://')) v = v.slice(7);
  // Trailing-slash and trailing-dot strip is interleaved on purpose — both
  // `"cnn.com./"` and `"cnn.com/."` collapse to `"cnn.com"` because each
  // iteration peels whichever terminator is currently at the end. This is
  // a security boundary (writer-vs-validator parity); two strings that
  // refer to the same publisher MUST canonicalize identically regardless
  // of the order of their non-significant trailing characters.
  while (v.endsWith('/') || v.endsWith('.')) v = v.slice(0, -1);
  return v;
}
