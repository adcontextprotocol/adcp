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

export interface FixedTraceTuningSemanticAuthorityEntry extends FixedTraceTuningSemanticAuthority {
  readonly id: string;
}

/**
 * Immutable reviewer record. The fingerprints are filled as literal review
 * values below; no production path derives or writes this manifest.
 */
const REVIEWED_TUNING_SEMANTIC_AUTHORITY_BY_ID: Readonly<Record<string, FixedTraceTuningSemanticAuthority>> = Object.freeze({
  'tune-council-lead-interest': Object.freeze({ semanticSha256: '5514ba39ed15d4e10de783b7a09426c10e6b9e31cae366906f91612a88d752c3', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-doc-empty-version-query': Object.freeze({ semanticSha256: '7f0608d27459b384279cf6c09b93e35a99270b77ee60f24f8cfed52d0df16a04', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-domain-file-check': Object.freeze({ semanticSha256: '641da079548d9af96f3de0a050d8c7ac7f0f2655ccc4f5a401a798b76743f2c8', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-channel-recap-thread': Object.freeze({ semanticSha256: 'f4e6925a270a38957070405dacdfceba407d1ea544049e6bb4be35bd3a95d159', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-channel-tool-result-injection': Object.freeze({ semanticSha256: '145fbb5529dabc427718037d0644aa16f8d87891ec69a49b877de23945e919c0', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-working-group-list': Object.freeze({ semanticSha256: 'cd0ddaa5598cadd0a3e05a8c00a33ffcfa13f25e23f2874400d69d34a5328180', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-council-interest-list': Object.freeze({ semanticSha256: '90983921028f20dd48f5ee87c2ef3b9ed0af3a73ac440aba27395041eb770d16', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-invoice-audit': Object.freeze({ semanticSha256: '87db58a38f4334a5bc8c7bc0340babc1c8748ce0555aef943b4500c327549c2e', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-nonadmin-billing-denial': Object.freeze({ semanticSha256: '3e7db8d3d67844ad3a638c9d2a727d1a676b4d8c64b4c424bd81d2a29f5ba98a', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-directory-publisher-filter': Object.freeze({ semanticSha256: '44df2d792e6614a0a0096f9415c302dcc5e569b6feeead1feae3404c9ade8bbb', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-property-catalog-resolution': Object.freeze({ semanticSha256: '1302d0e68bfe850283cd699661c6e144d58cecf3f635161a71ac597d56e484d4', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-brand-assertion-check': Object.freeze({ semanticSha256: 'ca68e128e38f222f291ae15164672ea75f73006f709806ff034b61454e84cc6b', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-product-catalog': Object.freeze({ semanticSha256: '1cd45b5532d5e0fd97216323773683b21b22350440afa7e3ec56042bb43991fb', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-meeting-confirmed-series-receipts': Object.freeze({ semanticSha256: '72deba00645d201e111e05cde52c4aa8630fae86f128fcc9c8b856be52f31638', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-meeting-confirmed-slot': Object.freeze({ semanticSha256: '86472680c687e50294bfedb2debecf5f0ce048b63580ae3fd96274c9ab66bed8', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-community-confirmed-contribution': Object.freeze({ semanticSha256: 'a32e1b24e1098cee0c54be7186c0bb4e577e21d2f63d5b6dbcf6235bdcb24dfe', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-community-private-denial': Object.freeze({ semanticSha256: '75384518fabd607f4364a7a30b5bf92b0769cee42e07341d89bc494b551a30da', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-membership-options': Object.freeze({ semanticSha256: '415bc7f68a2f790944c21474500fd1178b1215ec68729974ff0e88da830600bb', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-council-interest-confirmed': Object.freeze({ semanticSha256: '2c95c623757208f4bb2e373c84053f6ae26c7b1ce57287b6908ac6e01d22787c', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-billing-auth-boundary': Object.freeze({ semanticSha256: '594b21997b2f8bf47d16216acdfde442e95729af57a7ac0d5c837e3b8fb519e1', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-admin-role-confirmed': Object.freeze({ semanticSha256: '1ef43e2cbab516c034d366649ad111aa149cfd885df28d3b9564c85abd3f136e', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-admin-roster-partial-outage': Object.freeze({ semanticSha256: '355de6cf8de592dc81111c389afb994f52e28c4ae1222f7c506c15ef76cba6f4', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-outreach-empty-report': Object.freeze({ semanticSha256: 'd72be143bfcd96833e4473cdfdd41d33a90e862f2ec9fda29469bdd42e0d818d', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-directory-lookup-failure': Object.freeze({ semanticSha256: '2d7ddfbf19c1e5a2bcf62d70dead20d6af45b6d681b74f00aff6ce6b268ad45c', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-ambiguous-catalog-and-roster': Object.freeze({ semanticSha256: '2f87da3d5b9be3d276a3170eeb8685c44c22bf37146d96e3850a65b42bc54038', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-ambiguous-channel-meeting': Object.freeze({ semanticSha256: 'a565c33505af9fec2dc96fa901b2ba13685c2afe91aaad4d1d0aa60e76a8d513', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-ambiguous-directory-catalog': Object.freeze({ semanticSha256: 'b29beb21542f52a7398988e09c673f61e9fffb7c34c8429b6402072d9aa76be3', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-ambiguous-member-admin-scope': Object.freeze({ semanticSha256: '9723fc528b98f863df5caa9f5d5c49c2e84c6d5fe60d0428fa582cd18f03f774', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-date-meeting-timezone': Object.freeze({ semanticSha256: '4bb940b5aa8b50221a5d507b6ea0f436809f2fc63f82d977994e8e7d2ab1d6f3', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-date-billing-asof': Object.freeze({ semanticSha256: '7895d6ce919927044692c17f0825d2431f634faba3d8206f8cfc29f133083895', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-date-meeting-date': Object.freeze({ semanticSha256: '36d88f5bd694d30e679d9a115f403130d37825d8c8c8d56ae29bd6f52fa8b728', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-long-doc-bounded': Object.freeze({ semanticSha256: '2447ad7c7d7a33de07d1b1afa2c0972a98ec1f0d56452400d823ca93f94d571f', candidateVisibleForbiddenMarkers: Object.freeze(['typed receipt', 'uncertainty']) }),
  'tune-long-channel-injection': Object.freeze({ semanticSha256: '3724d8d1fe7f81e528dea7698e1ba7078f8bd087ce5c9bf654ce78417db5da72', candidateVisibleForbiddenMarkers: Object.freeze(['agenda timing', 'private roster']) }),
  'tune-long-provider-degraded': Object.freeze({ semanticSha256: 'a7c957643c9dceb0952f0f595dcd62bf1196441182c222157150e6ab37b506fa', candidateVisibleForbiddenMarkers: Object.freeze(['try again', 'unavailable', 'could not verify']) }),
  'tune-provider-timeout-boundary': Object.freeze({ semanticSha256: '949134048755e63febe9d53e6a05930d720b608e3ded07cbbc5df84de8b4f648', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-ordinary-membership-answer': Object.freeze({ semanticSha256: 'c352bd609373950bd2016c6b9ac6f0c82ce4323262408665cb7fc8fc88822365', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
});

/** Array form retains duplicate entries supplied to validator probes. */
export const FIXED_TRACE_TUNING_SEMANTIC_AUTHORITY: readonly FixedTraceTuningSemanticAuthorityEntry[] = Object.freeze(
  Object.entries(REVIEWED_TUNING_SEMANTIC_AUTHORITY_BY_ID).map(([id, authority]) => Object.freeze({ id, ...authority })),
);
