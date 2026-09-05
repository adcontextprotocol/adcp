/**
 * Reviewer-owned semantic authority for the tuning corpus.
 *
 * This file is deliberately data-only and does not import the corpus builder.
 * Its literals were recorded during review, so editing a replay case cannot
 * restamp the semantic contract it is checked against.
 */
export const FIXED_TRACE_TUNING_SEMANTIC_AUTHORITY_VERSION = 'reviewed-tuning-semantics-v1';

export interface FixedTraceTuningSemanticAuthority {
  /** SHA-256 of the complete replay semantics, not a corpus-provided hash. */
  readonly semanticSha256: string;
  /** Evaluator-only markers which must never occur in candidate request text. */
  readonly candidateVisibleForbiddenMarkers: readonly string[];
}

/**
 * Immutable reviewer record. The fingerprints are filled as literal review
 * values below; no production path derives or writes this manifest.
 */
export const FIXED_TRACE_TUNING_SEMANTIC_AUTHORITY: Readonly<Record<string, FixedTraceTuningSemanticAuthority>> = Object.freeze({
  'tune-council-lead-interest': Object.freeze({ semanticSha256: '226c5e85e5c1a65f5390e99545c09114ce5a191d3b687cb5ce0e77991ad50429', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-doc-empty-version-query': Object.freeze({ semanticSha256: '23e316598690d959a299da841cef2c26405bc0f806600e28e344849acdbec8d0', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-domain-file-check': Object.freeze({ semanticSha256: '29c216bc294b01f3ac3b37e9bbdb60350ec4c9071ba733de8223011df7511942', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-channel-recap-thread': Object.freeze({ semanticSha256: '7a8ab902643164318094804c0557d24dda01b153a3eb5be00fc75db5feea7859', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-channel-tool-result-injection': Object.freeze({ semanticSha256: 'c57a39c5f43d50aab58afd2926ecddaa9d7fb6bbcd8fd629c31ca0cac84355da', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-working-group-list': Object.freeze({ semanticSha256: 'e4f97ce2a7fd8ee8d41288fb3428f596f1a8cd54e0dd90dbbf38fb4a2afe1eb8', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-council-interest-list': Object.freeze({ semanticSha256: 'a9d46af0eee527874dacf764dd528eb5c4bda1da03769c2b598c9f86a87d818d', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-invoice-audit': Object.freeze({ semanticSha256: 'a2974710af5e7f75f9d57e903d8225111e2f19b9b227343431870ef68767355b', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-nonadmin-billing-denial': Object.freeze({ semanticSha256: '645da6f0b464ce476fa71930ed3f075086a196816efea13271295de4223c8e19', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-directory-publisher-filter': Object.freeze({ semanticSha256: 'd6131553b5bdea42c2c1c8e2a9d3f1adc32fb5c2c1e57116f582df47bdd53269', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-property-catalog-resolution': Object.freeze({ semanticSha256: '18d74a060c9ae13fdc1bf8b8f8d5d9f2c308eac399b415cdbf44753f4b9f9511', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-brand-assertion-check': Object.freeze({ semanticSha256: '8931beb22147c4061a9e3d132aadb60b48498bd771a2e21631048af1f043d061', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-product-catalog': Object.freeze({ semanticSha256: 'e96427dbd09f4d0e9c1a51b19e5e2c83be002636c1c02aed741d3ff99fee5c4d', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-meeting-confirmed-series-receipts': Object.freeze({ semanticSha256: '51f968d3a2a3c4b096994d4e0f53271ef72c75dc3faacf239048b0d9df4bf5f5', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-meeting-confirmed-slot': Object.freeze({ semanticSha256: '953d3f43aa7a608ec4bc488d830e51a3a745bacfd46d95bc89d8a826be7d0fb9', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-community-confirmed-contribution': Object.freeze({ semanticSha256: '3e16894d8270f35046222e1e388a1fdb251108216b2c6f187a86744e257c0848', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-community-private-denial': Object.freeze({ semanticSha256: 'd25e123597f7d5fa89d6487920b4481756d98ba148969d15dfb9cb21a48e57a7', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-membership-options': Object.freeze({ semanticSha256: '9b6b2b272178c057e289560ef146a968b8ca2345b78922318515f56b6f50cef4', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-council-interest-confirmed': Object.freeze({ semanticSha256: '22387d274d75a26b1558e90a7e751f118c52958014e67b170aa50784c9f7e375', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-billing-auth-boundary': Object.freeze({ semanticSha256: '52418db58db5c53cdca30dfbfbeed1437e3277c7f7316ea106c20e27a486c715', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-admin-role-confirmed': Object.freeze({ semanticSha256: 'dc0861a5a7d8bc96a966a854ce63d90219d510df56ad37fc175e250b5bf66f2f', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-admin-roster-partial-outage': Object.freeze({ semanticSha256: '122f118605fafe9c95bd42522a168a9f60466651c31b309c2f619197518c8221', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-outreach-empty-report': Object.freeze({ semanticSha256: 'f7458b180e9b256202c16c0bf4125db52f1b2887b00bb34ff85e7e463c4e7300', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-directory-lookup-failure': Object.freeze({ semanticSha256: '83464bf6ab1110e58fff1dfa77f84943a218bb42c30d7bd12398926351c09503', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-ambiguous-catalog-and-roster': Object.freeze({ semanticSha256: '1bd724d8991bda427e82f886ecf1cfd27819fcbaadecf92bdd7b8db9c8150125', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-ambiguous-channel-meeting': Object.freeze({ semanticSha256: 'a5cd79109eac8df10b61da3101fb57de350e7d794cd0a27d29fc15728ae60ee1', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-ambiguous-directory-catalog': Object.freeze({ semanticSha256: '98be5d0177855d4352de4bd7bb62ecc90ffa532cbceb8063395a65ad9f97eb1e', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-ambiguous-member-admin-scope': Object.freeze({ semanticSha256: 'aa4edd27f909d209f7b725ed34f71f035377683fe1c364954b5a802f81bd9dee', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-date-meeting-timezone': Object.freeze({ semanticSha256: '9edb6b4da1bd160a4b5b0e9c756d5a93d7dc41f9bd84843d9a79c7485bde02c2', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-date-billing-asof': Object.freeze({ semanticSha256: 'dba7d6721c31328428ec9edf67560edb0ab7484dfeeaf348d5922850a860cc9c', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-date-meeting-date': Object.freeze({ semanticSha256: '63c7c1926e5c8b31a6af2ef6fb3d3ec7c8fb28d0a8b9bd6fafc213184764c35d', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-long-doc-bounded': Object.freeze({ semanticSha256: 'cadf43cdad12828f482df624eedb9ff59388b48a5578013e94a4100bdf6380a2', candidateVisibleForbiddenMarkers: Object.freeze(['typed receipt', 'uncertainty']) }),
  'tune-long-channel-injection': Object.freeze({ semanticSha256: '756c135fc6dc31932fddc3c8b54c103e57daf1b847670d9162a0609e4321ca4f', candidateVisibleForbiddenMarkers: Object.freeze(['agenda timing', 'private roster']) }),
  'tune-long-provider-degraded': Object.freeze({ semanticSha256: 'b217ed5ed2b3c5ca087f76b3cf3f82b867c56de747e1fbc949e3295f1902e62a', candidateVisibleForbiddenMarkers: Object.freeze(['try again', 'unavailable', 'could not verify']) }),
  'tune-provider-timeout-boundary': Object.freeze({ semanticSha256: '8d103f6a96f973a3984ff38de73b3f1a2188e6179e82c64f2eb1b1b927340db8', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-ordinary-membership-answer': Object.freeze({ semanticSha256: '0d7d12295bf7ecf31ad4e9bc85d9f67b875d8037a713f8750fd1a9bfcb89b274', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
});
