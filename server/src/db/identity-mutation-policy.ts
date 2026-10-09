/**
 * Temporary containment for #6827. Generic consolidation cannot preserve
 * credential authority or membership provenance, in either direction.
 * Operator confirmation, empty previews and caller privilege are not bypasses.
 */
export class IdentityMutationDisabledError extends Error {
  readonly code = 'identity_mutation_disabled';

  constructor() {
    super('Identity consolidation is disabled until authority and provenance can be preserved.');
    this.name = 'IdentityMutationDisabledError';
  }
}

export function assertIdentityConsolidationAllowed(): void {
  throw new IdentityMutationDisabledError();
}
