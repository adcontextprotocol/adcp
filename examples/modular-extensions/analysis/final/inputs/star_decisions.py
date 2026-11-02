"""Star analysis decisions (frozen input): one class per cross-module $ref edge, and the file moves that follow.

The star analysis is not shipped; final/place_final.py and final/verify_final.py read this table as data.

Classes (exactly one per edge):
  a  SHARED FORMAT   both sides need the same data format -> kernel types (whole file), or
                     "a-split": a stable core goes to kernel types and the owner keeps the rest
  b  EMBEDDING       a module includes another module's object -> reference it by a kernel id
  c  BRIDGE          a feature that combines two modules -> extension point declared by one side,
                     filled by a bridge extension, linked by a kernel id
  d  GENUINE         a dependency that has to stay (none are kept in the star analysis)
  e  MISPLACED       the file (or the referring definition) belongs in another module, in kernel
                     types, in the generated assembly, or in the owning module's test-scenario
                     fragment

TARGET[dst] = (class, destination, kernel id or core type, note)
  destination: "kernel-types" / "kernel" / "module:<m>" moves the file; None keeps it in place.
EDGE[(src, dst)] or EDGE[(src_module, dst)] overrides TARGET for one edge.
DISSOLVE lists modules whose remaining files follow their referrers.
"""

KT, KN = "kernel-types", "kernel"

BRIDGES = {
    "C1": ("governance-checks-on-buying", "governance check_governance subject point", "proposal_ref, media_buy_ref"),
    "C2": ("reliable-reporting-attachments", "account.reporting, principal.declarations, "
           "delivery.reporting_revision points (bridge C2)", "account_ref, media_buy_ref"),
    "C3": ("creative-approvals-on-packages", "buying package.creative_approvals point", "creative_ref"),
    "C4": ("format-declarations-on-products", "buying product.format_options point keyed by format_kind",
           "format_kind_id, format_option_ref, format_id"),
    "C5": ("creative-signal-fanout", "creative build_creative.conditions point", "signal_ref"),
    "C6": ("audience-evidence-on-products", "buying product.audience_evidence point", "signal_ref, evidence pin"),
    "C7": ("content-artifacts-for-evaluation-and-context", "creative evaluator input point, TMP context point",
           "artifact_ref"),
}

TARGET = {
    # ---------------------------------------------------------------- accounts
    "core/account.json": ("b", None, "account_ref", "responses embed the full account; carry account_ref"),
    "core/business-entity.json": ("a", KT, "", "legal-entity format for invoicing; buying, governance, accounts"),
    "core/canonical-account-ref.json": ("e", KT, "account_ref", "an account reference type; belongs with account-ref"),
    "core/webhook-activity-record.json": ("e", KN, "", "one webhook delivery attempt; webhook delivery is kernel"),
    "enums/cloud-storage-protocol.json": ("a", KT, "", "transport enum shared by accounts and buying"),
    # ---------------------------------------------------------------- buying
    "core/audience-selector.json": ("a", KT, "", "signal_ref or description; same family as signal-targeting"),
    "core/canonical-proposal.json": ("c", None, "C1", "governance check on a proposal"),
    "core/catalog.json": ("b", None, "catalog_ref", "creative catalog-asset (a kernel-cut fix) and TMP embed the catalog"),
    "core/content-rating.json": ("a", KT, "", "inventory classification shared with governance lists"),
    "core/package-format-snapshot.json": ("b", None, "format_option_ref", "TMP embeds the package format snapshot"),
    "core/planned-delivery.json": ("c", None, "C1", "governance check on planned delivery"),
    "core/property-tag.json": ("e", KT, "property_tag", "an identifier string"),
    "core/property.json": ("b", None, "property_id", "property-error embeds the property"),
    "core/seller-agent-ref.json": ("e", KT, "agent_ref", "an agent reference; graduates as kernel agent-ref"),
    "enums/collection-kind.json": ("a", KT, "", "inventory classification shared with governance lists"),
    "enums/distribution-identifier-type.json": ("a", KT, "", "identifier namespace; open id with known values"),
    "enums/genre-taxonomy.json": ("a", KT, "", "taxonomy id shared with governance lists"),
    "enums/production-quality.json": ("a", KT, "", "inventory classification shared with governance lists"),
    # ---------------------------------------------------------------- creative
    "content-standards/artifact.json": ("e", "module:governance", "artifact_ref",
                                        "content-standards format filed under creative; governance owns it"),
    "core/assignment-tracker.json": ("a", KT, "", "tracker format shared by creative and buying"),
    "core/canonical-format-kind.json": ("a-split", None, "format_kind_id",
                                        "closed enum that grows; kernel gets an open id, creative keeps the list"),
    "core/canonical-format-option.json": ("c", None, "C4", "product narrows a canonical format"),
    "core/creative-approval-scope.json": ("c", None, "C3", "creative review state on packages"),
    "core/creative-asset.json": ("b", None, "creative_ref", "inline creative upload on packages"),
    "core/creative-assignment.json": ("e", "module:buying", "", "only buying uses it: assignment of a creative_id"),
    "core/creative-locale-policy.json": ("c", None, "C4", "product narrows a canonical format"),
    "core/creative-manifest.json": ("b", None, "creative_ref", "TMP offer embeds the manifest; carry ref + digest"),
    "core/format-option-ref.json": ("e", KT, "format_option_ref", "a reference type"),
    "core/indicator-bearing.json": ("a-split", None, "indicator",
                                    "1 non-additive change; kernel gets indicator items, each module owns the wrapper"),
    "core/indicator-scope.json": ("a", KT, "", "resource-scoped indicator format"),
    "core/indicator.json": ("a", KT, "", "resource-scoped indicator format"),
    "core/macro-bearing-url.json": ("a", KT, "", "URL-with-macros string format"),
    "core/product-format-declaration.json": ("c", None, "C4", "product narrows a canonical format"),
    "enums/catalog-type.json": ("a", KT, "", "catalog type id shared by creative and buying"),
    "enums/creative-approval-status.json": ("c", None, "C3", "creative review state on packages"),
    "enums/daast-version.json": ("a", KT, "", "IAB DAAST version"),
    "enums/indicator-type.json": ("a-split", None, "indicator_type_id", "open id; creative keeps the known values"),
    "enums/snapshot-unavailable-reason.json": ("c", None, "C3", "creative review state on packages"),
    "enums/vast-version.json": ("a", KT, "", "IAB VAST version"),
    # assets used by buying (catalog offerings, product cards, collections)
    **{f"core/assets/{n}-asset.json": ("a-split", None, "media_asset",
                                         "buying needs the asset core (type, url, size); creative keeps typed bodies")
       for n in ("audio", "css", "daast", "html", "image", "javascript", "markdown", "published-post", "text",
                 "url", "vast", "video", "webhook", "zip")},
    # ---------------------------------------------------------------- identity
    "core/attestation-evaluation.json": ("a", KT, "", "evaluator result format used by signals, creative, governance"),
    "core/attestation-issuer.json": ("a", KT, "", "part of the attestation reference"),
    "core/attestation-reference.json": ("a", KT, "attestation_ref", "reference-first claim presentation"),
    "core/attestation-subject.json": ("a", KT, "", "part of the attestation reference"),
    "enums/advertiser-industry.json": ("a", KT, "", "industry classification; brand.json and buying"),
    "enums/asset-content-type.json": ("a-split", None, "asset_type_id", "growing enum; kernel gets an open id"),
    "enums/feed-format.json": ("a", KT, "", "feed format id; brand.json, catalogs, creative"),
    "enums/logo-slot.json": ("a", KT, "", "logo slot id; brand.json and creative"),
    "enums/property-type.json": ("a", KT, "", "property type id; identity, buying, governance, TMP"),
    "enums/right-type.json": ("a-split", None, "right_type_id",
                              "experimental list stays in identity; kernel gets the open id format"),
    "enums/right-use.json": ("a-split", None, "right_use_id",
                             "experimental list stays in identity; kernel gets the open id format"),
    "enums/talent-role.json": ("a", KT, "", "talent role id; brand.json and buying"),
    # ---------------------------------------------------------------- media-vocabulary (multi-module part)
    "core/vendor-metric-id.json": ("a", KT, "metric_id", "vendor metric id"),
    "enums/available-metric.json": ("a-split", "module:buying", "metric_id",
                                    "13 commits, 1 non-additive; kernel gets open metric_id, list stays in buying"),
    "core/delivery-metrics.json": ("a-split", "module:buying", "metric_value",
                                   "28 -> 46 fields since GA; creative reports metric_value[] keyed by metric_id"),
    "core/forecast-point.json": ("a-split", "module:buying", "forecast_range + metric_id",
                                 "signals coverage points use kernel forecast-range keyed by metric_id"),
    "core/forecast-range.json": ("a", KT, "", "low/mid/high numeric range"),
    "core/feature-requirement.json": ("a", KT, "", "feature predicate; governance and creative"),
    "core/identifier.json": ("a", KT, "", "type + value; per-type value rules (#8289, Oct 18) move to buying"),
    "enums/identifier-types.json": ("a", KT, "", "identifier namespace; open id with known values"),
    "enums/metro-system.json": ("a", KT, "", "geo system id"),
    "enums/viewability-standard.json": ("a", KT, "", "metric qualifier"),
    "enums/attribution-methodology.json": ("a", KT, "", "metric qualifier"),
    "enums/completion-source.json": ("a", KT, "", "metric qualifier"),
    "enums/lift-dimension.json": ("a", KT, "", "metric qualifier"),
    "enums/event-type.json": ("a", KT, "", "conversion event type; open id"),
    "enums/action-source.json": ("a", KT, "", "event source channel"),
    "enums/age-determination-basis.json": ("a", KT, "", "demographic vocabulary"),
    "core/demographic-predicate.json": ("a", KT, "", "portable demographic predicate"),
    "core/demographic-age-range.json": ("a", KT, "", "closure of demographic-predicate"),
    "core/audience-size.json": ("a", KT, "", "people count as a range; 11 days old"),
    "enums/audience-size-precision.json": ("a", KT, "", "closure of audience-size"),
    "enums/forecast-method.json": ("a", KT, "", "forecast method"),
    "enums/restricted-attribute.json": ("a", KT, "", "restricted data attribute; signals, governance, buying"),
    "enums/validation-mode.json": ("a", KT, "", "sync validation mode; creative and buying"),
    "governance/policy-entry.json": ("e", "module:governance", "", "only governance uses it"),
    "enums/policy-enforcement.json": ("e", "module:governance", "", "only governance uses it"),
    "enums/metric-type.json": ("e", "module:reporting", "", "only reporting uses it"),
    "core/committed-metric.json": ("e", "module:buying", "", "only buying uses it (plus test params)"),
    # ---------------------------------------------------------------- signals
    "core/activation-key.json": ("e", KT, "activation_key", "an identifier for a signal on a platform"),
    "core/audience-characteristic.json": ("c", None, "C6", "audience evidence on products"),
    "core/audience-evidence.json": ("c", None, "C6", "audience evidence on products"),
    "enums/audience-evidence-methodology.json": ("c", None, "C6", "audience evidence on products"),
    "enums/audience-resolution-method.json": ("c", None, "C6", "audience evidence on products"),
    "enums/audience-subject-type.json": ("c", None, "C6", "audience evidence on products"),
    "core/audience-evidence-pin.json": ("e", "module:buying", "", "only buying uses it"),
    "core/audience-evidence-requirements.json": ("e", "module:buying", "", "only buying uses it"),
    "core/audience-evidence-selection.json": ("e", "module:buying", "", "only buying uses it"),
    "core/data-provider-signal-selector.json": ("e", "module:buying", "", "only buying uses it"),
    "core/signal-selection-group-rule.json": ("e", "module:buying", "", "only buying uses it"),
    "core/diagnostic-issue.json": ("a", KT, "", "code + message diagnostic"),
    "enums/assessment-status.json": ("a", KT, "", "readiness status"),
    "core/signal-targeting.json": ("a", KT, "", "signal_ref + value predicate; 1 non-additive (signal_ref migration)"),
    "enums/uid-type.json": ("a", KT, "", "user id type; open id (TMP needs world_id_nullifier)"),
    "core/signal-listing.json": ("b", None, "signal_ref", "products embed signal listings"),
    # wholesale-feed-event #signal branch: the definition belongs to signals
    "core/deployment.json": ("e", None, "", "#signal branch of wholesale-feed-event belongs in signals"),
    "core/signal-coverage-forecast.json": ("e", None, "", "#signal branch of wholesale-feed-event belongs in signals"),
    "enums/signal-catalog-type.json": ("e", None, "", "#signal branch of wholesale-feed-event belongs in signals"),
    "enums/signal-value-type.json": ("e", None, "", "#signal branch of wholesale-feed-event belongs in signals"),
    # ---------------------------------------------------------------- reporting (bridge C2)
    **{f"core/{n}.json": ("c", None, "C2", "Reliable Reporting attachment (bridge C2)")
       for n in ("agent-reporting-destination-state", "agent-reporting-destination", "reporting-control-total",
                 "reporting-delivery-config-state", "reporting-delivery-config", "reporting-revision")},
}

EDGE = {
    # signal fan-out is the bridge, even though signal-targeting itself is a kernel type
    ("module:creative", "core/signal-targeting.json"): ("c", None, "C5", "signal-driven creative fan-out"),
    # wholesale feed: listing embedded in the #signal branch is part of the misplaced branch
    ("core/wholesale-feed-event.json", "core/signal-listing.json"):
        ("e", None, "", "#signal branch of wholesale-feed-event belongs in signals"),
    # artifact users other than governance become bridges once artifact moves to governance
    ("module:trusted-match", "content-standards/artifact.json"): ("c", None, "C7", "TMP context match on artifacts"),
    ("module:creative", "content-standards/artifact.json"): ("c", None, "C7", "creative evaluator input"),
    # delivery-metrics: creative's two refs are the split; buying's become internal
    ("module:creative", "core/delivery-metrics.json"): ("a-split", None, "metric_value",
                                                        "creative reports metric_value[] keyed by metric_id"),
    # TMP's catalogs are experimental; same embedding fix
}

# Induced edges: they appear only after a file moves. Each needs a class too.
INDUCED = {
    # content-standards artifact moves to governance; its refs into creative
    ("content-standards/artifact.json", "core/provenance.json"): ("a", KT, "", "provenance format; creative and governance"),
}

DISSOLVE = ["module:media-vocabulary"]

# Files that are not cross-module targets today but must move with a decision above.
MOVES = {
    # kernel-type closure: a kernel type may $ref only kernel and kernel types (kernel-cut rule L1)
    "enums/pixel-tracking-event.json": (KT, "a", "closure of assignment-tracker"),
    "enums/content-rating-system.json": (KT, "a", "closure of content-rating"),
    "enums/c2pa-watermark-action.json": (KT, "a", "closure of provenance"),
    "enums/digital-source-type.json": (KT, "a", "closure of provenance"),
    "enums/disclosure-persistence.json": (KT, "a", "closure of provenance"),
    "enums/disclosure-position.json": (KT, "a", "closure of provenance"),
    "enums/embedded-provenance-method.json": (KT, "a", "closure of provenance"),
    "enums/watermark-media-type.json": (KT, "a", "closure of provenance"),
    # seller acceptance policies are buying's; governance points at a profile by id
    "media-buy/acceptance-policy-profile.json": ("module:buying", "e", "seller acceptance policy"),
    "media-buy/acceptance-policy-rule.json": ("module:buying", "e", "seller acceptance policy"),
    "media-buy/acceptance-policy-requirement.json": ("module:buying", "e", "seller acceptance policy"),
    "media-buy/acceptance-policy-catalog.json": ("module:buying", "e", "seller acceptance policy"),
    "media-buy/acceptance-policy-profile-ref.json": (KT, "e", "a reference type"),
}
INDUCED[("governance/policy-entry.json", "media-buy/acceptance-policy-profile.json")] = (
    "b", None, "acceptance_policy_profile_ref", "policy-entry.acceptance_profile embeds a seller acceptance profile")
