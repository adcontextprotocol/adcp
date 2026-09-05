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
  'tune-doc-empty-version-query': Object.freeze({ semanticSha256: 'f6110567fbab439b36ad062c2407d451581e98d4cf317470a4e3e287ea8cceac', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-domain-file-check': Object.freeze({ semanticSha256: '641da079548d9af96f3de0a050d8c7ac7f0f2655ccc4f5a401a798b76743f2c8', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-channel-recap-thread': Object.freeze({ semanticSha256: '62b0407015795ca28f4f372f5b1236c58c1803e45ff88537b66595adc4d26e2c', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-channel-tool-result-injection': Object.freeze({ semanticSha256: '7777f837985799ad8e2e5f217363869987553603fd6a68b825982264b79cee14', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-working-group-list': Object.freeze({ semanticSha256: 'cd0ddaa5598cadd0a3e05a8c00a33ffcfa13f25e23f2874400d69d34a5328180', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-council-interest-list': Object.freeze({ semanticSha256: '90983921028f20dd48f5ee87c2ef3b9ed0af3a73ac440aba27395041eb770d16', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-invoice-audit': Object.freeze({ semanticSha256: '2a8b68451fd21fabe4e5d96992dad7b5bf1c196b6d3f4641722764aaa7433c37', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-nonadmin-billing-denial': Object.freeze({ semanticSha256: '9bffb8f98454f562c04a50fe8dde17d99394aecd29334ba2c82e2c9670d0dfe5', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-directory-publisher-filter': Object.freeze({ semanticSha256: 'ac7de5d48aca65d405e21f17ada7fc9fc79d35066e8d559f0ed3d68d9513291e', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-property-catalog-resolution': Object.freeze({ semanticSha256: '351c141259087dd98a90f1a6030a7af7b61688b36fb66d9ca017e57fdd21e49c', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
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
  'tune-admin-roster-partial-outage': Object.freeze({ semanticSha256: 'a057c22bb96fd4579ce23a654d059debc1bcd1c9b3599c71005a70c506dd107d', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-outreach-empty-report': Object.freeze({ semanticSha256: '16916d7d94e525494397b5383805b1ad798e6eb456a130baefda14dc99626f36', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-directory-lookup-failure': Object.freeze({ semanticSha256: '2cabdcdd633d71bdc2aa00ad18a76cd6ee73e4eb25e8771496df0f37b4807fa1', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-ambiguous-catalog-and-roster': Object.freeze({ semanticSha256: 'aa6a1e9b1bcb662eac4a45fbe58f3597c3a7c0c83e58d1588f98e0a352657a48', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-ambiguous-channel-meeting': Object.freeze({ semanticSha256: '67a011297157f9b0e5e8ae5df151a977ffac2456c056f9a6624cb2079fafedac', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-ambiguous-directory-catalog': Object.freeze({ semanticSha256: '49496e9c3797bde728a004ac0c756b6ac34efb233145b39a7cfe88f0963fb487', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-ambiguous-member-admin-scope': Object.freeze({ semanticSha256: '9f17b383e445f21bb4bee23a4a3898933f747090e6ae83ca7ca43a9dfd8d75c1', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-date-meeting-timezone': Object.freeze({ semanticSha256: '4bb940b5aa8b50221a5d507b6ea0f436809f2fc63f82d977994e8e7d2ab1d6f3', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-date-billing-asof': Object.freeze({ semanticSha256: '3fc8bbc0174c87301c232476f34090504b1ba5dd8230be7947d638ebd23e5e2c', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-date-meeting-date': Object.freeze({ semanticSha256: '70e0c805c8eae2ca9ed5ec947fcfb19483f4bff4fa4e512f3bfbf26bda77b48e', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-long-doc-bounded': Object.freeze({ semanticSha256: 'b592bf45933685e7510634298f059d7fb99b5c12a43971dfc9c3762ec60f4260', candidateVisibleForbiddenMarkers: Object.freeze(['typed receipt', 'uncertainty']) }),
  'tune-long-channel-injection': Object.freeze({ semanticSha256: '8d1d0a5106f30c74581363e8b63dc70c4f5e1ae5d3ad53a7033c1ad4dc89a72a', candidateVisibleForbiddenMarkers: Object.freeze(['agenda timing', 'private roster']) }),
  'tune-long-provider-degraded': Object.freeze({ semanticSha256: 'a7c957643c9dceb0952f0f595dcd62bf1196441182c222157150e6ab37b506fa', candidateVisibleForbiddenMarkers: Object.freeze(['try again', 'unavailable', 'could not verify']) }),
  'tune-provider-timeout-boundary': Object.freeze({ semanticSha256: '949134048755e63febe9d53e6a05930d720b608e3ded07cbbc5df84de8b4f648', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
  'tune-ordinary-membership-answer': Object.freeze({ semanticSha256: 'c352bd609373950bd2016c6b9ac6f0c82ce4323262408665cb7fc8fc88822365', candidateVisibleForbiddenMarkers: Object.freeze([]) }),
});

/** Array form retains duplicate entries supplied to validator probes. */
export const FIXED_TRACE_TUNING_SEMANTIC_AUTHORITY: readonly FixedTraceTuningSemanticAuthorityEntry[] = Object.freeze(
  Object.entries(REVIEWED_TUNING_SEMANTIC_AUTHORITY_BY_ID).map(([id, authority]) => Object.freeze({ id, ...authority })),
);
