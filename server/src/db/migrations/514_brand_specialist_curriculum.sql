-- S7: Brand Protocol specialist module + specialist_brand credential.
--
-- Brand Protocol is a first-class domain (brand.json identity, distributed
-- self-publishing, brand hierarchy / brand_refs, verify_brand_claim signed
-- responses, trademarks, rights lifecycle) with no specialist credential until
-- now. The domain is two-speed: the identity/verification layer is mature and
-- is what this module GATES; the rights lifecycle (brand.rights_lifecycle) is
-- experimental and is TAUGHT but never badge-gated (see experimental-status).
--
-- All nine gated criteria are reasoning or hands-on against the public test
-- agent's brand tenant + well-known surfaces — resolving brand.json identity
-- (get_brand_identity), brand_refs[] ↔ house_domain reciprocity, operator
-- authorization (authorized_operators[]), bilateral adagents.json confirmation,
-- verify_brand_claim signed-response trust interpretation, the direction-
-- asymmetric trust rule, trademark disambiguation, identity→creative-generation,
-- and the trust-knowability boundary. None are recall. The gate is the nine
-- _append_criterion semantic IDs below; the exercise's inline success_criteria
-- is intentionally empty so the experimental rights lifecycle (taught, not
-- gated) is never required and no criterion is double-counted.
--
-- FK ordering within this file: module row before any _append_criterion('S7');
-- badge INSERT before the credential's badge_id FK.

-- ── Module S7 ─────────────────────────────────────────────────────
-- prerequisites '{A3}' matches the other S-track capstones; the Practitioner
-- requirement is enforced on the credential (requires_credential below), as it
-- is for every specialist. tenant_ids '{brand}' pins Sage at /brand/mcp, where
-- get_brand_identity / verify_brand_claim* live and whose parent router serves
-- the brand.json / adagents.json / jwks.json discovery + walkthrough fixtures.
INSERT INTO certification_modules (id, track_id, title, description, format, duration_minutes, sort_order, is_free, prerequisites, lesson_plan, exercise_definitions, assessment_criteria, tenant_ids) VALUES
('S7', 'S', 'Brand identity and verification',
 'Brand Protocol mastery: resolving brand.json identity, distributed self-publishing and mutual-assertion reciprocity (brand_refs[] ↔ house_domain), bilateral adagents.json confirmation, verify_brand_claim and verifying its signed_response (response-signing JWS), the direction-asymmetric trust model, and trademark disambiguation. Teaches the experimental rights lifecycle without gating it.',
 'capstone', 60, 7, false, '{A3}',
 '{
    "objectives": [
      "Resolve a brand''s identity via brand.json and get_brand_identity, distinguishing public from authorized fields",
      "Establish brand-hierarchy relationships are real by checking mutual assertion in both directions (brand_refs[] and house_domain)",
      "Distinguish the two organizational axes — brand-to-brand house hierarchy and brand-to-operator authorization (authorized_operators) — and verify which operators may act for a brand",
      "Confirm a delegated sales agent bilaterally against the publisher''s adagents.json and the agent''s own brand.json + signing keys",
      "Interpret a signed verify_brand_claim response for trust — a signature proves authorship not truth, an expired one is audit-only, reject on mismatch — and apply the direction-asymmetric trust rule (the verification mechanics belong to S6 Security)",
      "Disambiguate a trademark claim across registries, Nice classes, and licensing states",
      "Explain how brand.json identity drives on-brand creative generation — which fields are inputs vs hard constraints, and where rights-gated generation and the approval loop take over",
      "Reason about the trust framework — what the protocol can establish (identity via TLS, authorship via signature) vs what it cannot (real-world standing, withheld state) — and the external cross-checks that close the gap",
      "Reason about the experimental rights lifecycle (get_rights/acquire_rights/update_rights) without treating it as stable"
    ],
    "key_concepts": [
      {"topic": "brand.json as distributed identity", "teaching_notes": "brand.json is the self-published, self-hosted identity document a brand serves at /.well-known/brand.json — the analog of adagents.json for identity rather than sales authorization. It declares names, industries, logos, the house architecture (branded_house / house_of_brands), agents[] (typed brand-agent entries with jwks_uri), and the brand hierarchy. get_brand_identity is the agent-side affordance over the same surface: it returns public fields to anyone and gates colors/fonts/tone/voice/rights behind an authorized (linked-account) caller, listing withheld sections under available_fields. Teach learners to resolve identity from the static file AND the agent, and to read available_fields as the signal to re-request authorized=true."},
      {"topic": "Mutual-assertion trust (the load-bearing rule)", "teaching_notes": "Brand hierarchy is asserted from both ends: a house_of_brands parent lists sub-brands in brand_refs[]; each sub-brand points back with house_domain. A relationship is trusted only when BOTH directions agree — a single side''s claim is not trust-extending, because a malicious house could otherwise claim subsidiaries it does not have. The same asymmetry governs verify_brand_claim: assertion (owned/pending/licensed) requires reciprocation, but rejection (not_ours/disputed) is authoritative on a single signed response — a brand always has standing to refuse association. This is the single most important reasoning skill in the domain. TEACHING DELIVERY: if a learner names authorship-not-truth and consistency-not-standing unprompted on first contact, fast-track immediately — do not run confirming probes on a dimension already demonstrated."},
      {"topic": "Organizational hierarchy: two axes, and where operators fit", "teaching_notes": "Brand identity is not just attributes (colors, tone) — it encodes WHO an organization is and WHO may act for it, along two distinct axes. AXIS 1 (brand-to-brand, vertical identity): the house/sub-brand hierarchy — house_of_brands vs branded_house architecture, keller_type (master/endorsed/independent), brand_refs[] ↔ house_domain. This answers ''which brands belong to this house.'' AXIS 2 (brand-to-operator, who acts FOR the brand): the house declares authorized_operators[] in brand.json — the agencies, platforms, and in-house teams permitted to represent its brands, each scoped by domain, brands[] (or the ''*'' wildcard), countries, and scopes[] (media_buying, creative_generation, rights_clearance, governance, measurement, agent_operations). A seller/platform verifies an operator by resolving its domain against this list. This is the BUY-side counterpart of adagents.json''s authorized_agents[] (the SELL-side: who may sell a publisher''s inventory) — keep the three relationship types distinct: house membership (brand_refs), buy-side operator authorization (authorized_operators), and sell-side agent delegation (adagents.json). The operator axis surfaces at runtime in the Accounts Protocol: every action carries an account whose natural key is {brand, operator} (operator = the domain of the entity operating the account; equals the brand''s own domain when the brand operates directly). The seller''s require_operator_auth capability selects the reference shape — true = seller-assigned account_id namespaces with independent operator auth (use list_accounts); false = buyer-declared {brand, operator} pairs provisioned via sync_accounts. get_brand_identity''s ''authorized'' tier is exactly an operator (linked-account) view of the identity. TEACHING DELIVERY: introduce the three relationship axes one beat at a time, anchored to the learner''s world — never as a numbered list when the learner asked for plain language. The sell-side adagents.json axis only matters once a delegation question arises; do not pre-load it."},
      {"topic": "Bilateral adagents.json confirmation", "teaching_notes": "Selling authorization is two-sided. A publisher''s adagents.json names authorized_agents[] with a delegation_type (direct vs delegated). The buyer-side trust check is bilateral: the publisher authorizes the agent AND the agent declares itself in its own brand.json — neither side alone is sufficient, and an agent the publisher does not list fails. For delegated authority a publisher MAY pin the agent''s signing keys in adagents.json; when it does, the agent''s signed responses are trusted against that publisher pin rather than the agent''s own self-published keys — the key-discovery and signature-checking mechanics are a Security-specialist concern (S6), but a Brand specialist must understand WHY the publisher pin is the authority (it stops a compromised agent from rotating in its own key). This is the trust chain in docs/verification/overview — Northwind selling StreamHaus CTV under delegated authority from Sportshaus Holdings, with StreamHaus pinning Northwind''s key."},
      {"topic": "verify_brand_claim — asking the brand directly", "teaching_notes": "verify_brand_claim is one tool, four claim_types (subsidiary, parent, property, trademark). It answers from the brand''s live policy store — richer than the static file (pending_review, transferring, licensed_in). The brand-specialist skill is reading the answer and deciding the trust action: each answer is cryptographically SIGNED by the brand, so a valid signature proves the brand AUTHORED the answer — not that it is true. An expired signature is stale (audit evidence, not a fresh authorization). A response that fails verification, or whose signed content does not match the answer, is rejected. An unsigned/unverified answer, and the verification_status field on its own, are never trust-extending. verify_brand_claims batches many claims into one round-trip and one signature. HOW the signature is verified (resolving the brand''s published signing key, canonicalizing, checking the cryptographic signature) is a Security-specialist skill taught in S6 — a Brand specialist must know that responses are signed, that they must be verified, and what each verification outcome means for trust; they need not perform the cryptography themselves. TEACHING DELIVERY: when a learner pushes toward the cryptography, do NOT re-explain the mechanics — answer with a one-line handoff that puts the boundary in the learner''s mouth (ask whose job the byte-checking is — theirs, or Security''s). Name the specific S6 content (key resolution, canonicalization, the response-signing key) only for a producer/implementer who asks for the exact seam. At the close, land the S6 next step alone; mention S2/S5 and experimental rights as a single one-line aside, not a list."},
      {"topic": "Trademark disambiguation", "teaching_notes": "A mark can resolve differently per jurisdiction: owned in USPTO, licensed_in under EUIPO with a licensor_domain, disputed in JPO. Resolution uses registry, number, countries, and Nice classes; an unqualified mark with multiple matches returns AMBIGUOUS_MATCH and must be narrowed. licensed_in is unverified until the named licensor reciprocates licensed_out — the same mutual-assertion shape across the licensing edge. Clearing a creative against the wrong registration is the failure this skill prevents."},
      {"topic": "brand.json drives creative generation", "teaching_notes": "Brand identity is not decoration — it is the INPUT to on-brand generation, and this is what makes the authorized tier matter. A creative agent fetches brand.json (or calls get_brand_identity authorized), then pulls the wordmark/logos, applies the exact color palette and type scale, adopts the tone of voice, and obeys the restrictions — e.g. generating a food-forward composition with the headline below the image because visual_guidelines says no text over food imagery. Separate two roles: INPUTS the generator consumes (logos, colors, fonts, tone.voice, voice_synthesis provider/voice_id/settings) and CONSTRAINTS that bound what it may produce (tone.dos/donts, visual_guidelines.restrictions like ''Never place text over the athlete'', content_restrictions). Input quality determines output quality — a richer brand.json yields better generation with fewer corrections. These are exactly the fields get_brand_identity gates behind authorization, because a brand protects its generation inputs. A SECOND, EXPERIMENTAL path applies when generating with licensed talent likeness/voice (brand.rights_lifecycle): acquire_rights issues scoped generation_credentials that specific providers (Midjourney for likeness, ElevenLabs for voice) verify AT GENERATION TIME — the rights agent sets the permission, the provider enforces it; the grant carries a rights_constraint (uses/countries/impression_cap), required disclosure text, and a creative_approval loop where the generated asset is submitted back to the brand agent for review against identity guidelines and grant terms. Generation stops when the impression cap is hit. SCOPE BOUNDARY: the brand specialist owns the brand SIDE of the handoff — identity as input/constraint and the approval/rights interface. The mechanics of producing the creative (build_creative manifest/code modes, format selection, preview, sync) belong to the Creative (S2) and Generative Advertising (S5) specialists; cross-reference, do not re-teach. The rights-gated half is taught, not gated, because it rides the experimental rights lifecycle."},
      {"topic": "The trust framework: what you can and can''t know", "teaching_notes": "This is the intellectual spine of the domain — the epistemics of brand identity. Trust resolves at TWO layers that separate cleanly: (1) IDENTITY attributes (logos, colors, tone, tagline) are trusted from a single TLS-served brand.json — a brand controlling its own domain is authoritative for its own attributes, full stop (even a leaf whose parent claim is unreciprocated still has real identity; ''claimed-unverified ⇒ ignore the leaf entirely'' is WRONG). (2) RELATIONSHIPS (who owns a brand, who speaks for it) require BOTH sides to reciprocate. Then climb the knowability ladder for what each signal proves: TLS + domain control ⇒ this party controls this domain; a SIGNATURE (response-signing JWS) attests AUTHORSHIP under the published key within the iat/exp window — NOT truth, and explicitly not a non-repudiation receipt; MUTUAL ASSERTION proves CONSISTENCY between two parties, NOT real-world standing — two attacker-controlled domains can sign matching owned responses, so the final trust gate is still consumer-side domain control + TLS against the legal entity you expect, plus out-of-band real-world identity for high-trust decisions; REJECTION (not_ours/disputed) is authoritative on a single signed response. What the protocol CANNOT establish for you: real-world legal standing (only consumer-side / out-of-band — this is where verified-identity attestation, a SEPARATE experimental feature, lives); internal state the brand withholds (queue position, ticket state, team routing are never exposed); authorized-tier data you are not linked for; and freshness past exp (an expired envelope is audit evidence, not a fresh authorization signal). External cross-checks the protocol expects you to perform: trademark ⇒ public registry record; property ⇒ DNS/TLS; licensed_in ⇒ the named licensor reciprocating licensed_out. Traps: managed_by is a DIRECTORY field, not a trust field (never authorize on it); a standalone leaf''s silence trumps any third-party house claim."},
      {"topic": "Rights lifecycle (EXPERIMENTAL — taught, not gated)", "teaching_notes": "get_rights / acquire_rights / update_rights and the brand.rights_lifecycle capability cluster license talent, music, and stock media: discover offerings, acquire under campaign terms (auto_approve / pending_approval / rejected, with generation credentials and a rights_constraint), and amend a grant. This is a legal-construct surface added late in the 3.0 cycle and is marked EXPERIMENTAL — partial rights, sublicensing, revocation, and dispute resolution are expected to evolve. Learners should be able to walk the lifecycle and reason about governance of rights spend, but mastery of it is NOT required to earn this credential and is never assessed as a gate."}
    ]
  }',
 '[
    {
      "id": "s7_ex1",
      "title": "Brand identity and the verification trust chain",
      "description": "Resolve a brand''s identity, walk the bilateral trust chain across brand.json and adagents.json, verify a signed verify_brand_claim response, and disambiguate a trademark — then explore the experimental rights lifecycle.",
      "sandbox_actions": [
        {"tool": "get_brand_identity", "guidance": "Resolve a brand''s identity. Call once unauthorized and read available_fields to see what an unlinked caller is missing; call again with authorized=true to obtain the gated colors/fonts/tone/voice_synthesis/visual_guidelines/rights sections (the authorized tier is an operator/linked-account view, and these gated fields are exactly the on-brand creative-generation inputs and constraints). Map each: logos/colors/fonts/tone.voice/voice_synthesis are generation INPUTS; tone.dos/donts and visual_guidelines.restrictions are hard CONSTRAINTS. Also resolve the house brand.json''s authorized_operators[] to see which operators may act for the brand — the buy-side counterpart of adagents.json."},
        {"tool": "verify_brand_claim", "guidance": "Ask a subsidiary, parent, property, or trademark claim, then INTERPRET the answer for trust: it is cryptographically signed by the brand, so a valid signature proves the brand authored it (not that it is true); an expired signature is stale (audit-only); a response that fails verification or whose signed content does not match must be rejected; never trust an unsigned/unverified answer or the verification_status field alone. (How the signature is verified is an S6 Security skill — here, reason about what each outcome means.) Cross-check brand_refs[] ↔ house_domain (mutual assertion) and the publisher''s adagents.json (delegated authority) before extending trust; treat not_ours/disputed as authoritative on a single response."},
        {"tool": "verify_brand_claims", "guidance": "Verify several claims in one round-trip; confirm the single batch signed_response covers every result."},
        {"tool": "get_rights", "guidance": "EXPERIMENTAL (brand.rights_lifecycle) — explore the rights catalog and reason about the acquire/update lifecycle, the scoped generation_credentials acquire_rights issues for provider-enforced talent generation, the required disclosure + impression cap, the creative_approval loop, and rights-spend governance. Not assessed as a credential gate."}
      ],
      "success_criteria": []
    }
  ]',
 '{
    "dimensions": [
      {"name": "identity_resolution", "weight": 20, "description": "Resolves brand.json identity (public/authorized field split) and maps the resolved fields to their role as creative-generation inputs and constraints", "scoring_guide": {"high": "Resolves identity from both the static file and get_brand_identity, reads available_fields, re-requests authorized fields deliberately, and explains how colors/fonts/logos/tone/voice_synthesis/visual_guidelines feed and constrain on-brand generation", "medium": "Resolves public identity but misses the authorization tier or the generation-input mapping", "low": "Cannot resolve brand identity or read the field-gating signal"}},
      {"name": "trust_chain_verification", "weight": 25, "description": "Walks the bilateral trust chain across all three relationship axes by their distinct checkpoints: brand_refs[]/house_domain reciprocity, authorized_operators[] (buy-side operator authorization), and adagents.json delegation (sell-side)", "scoring_guide": {"high": "Demonstrates all three axes by their checkpoints: confirms house membership in BOTH directions (parent brand_refs[] AND sub-brand house_domain); verifies operator authorization against authorized_operators[] (domain / brands incl the ''*'' wildcard / countries / scopes) AND explicitly distinguishes the buy-side operator axis from house membership and from sell-side agent delegation; and confirms a delegated agent by self-declaration in its own brand.json PLUS the publisher''s adagents.json authorization, understanding that a publisher key-pin makes the publisher the trust authority for the agent''s signed responses (the verification mechanics are an S6 Security skill). Mechanically resolving the data without these distinctions is NOT high", "medium": "Resolves the relevant data but conflates the three axes, confirms only one direction of a relationship without verifying the other, or does not grasp that a publisher pin overrides the agent''s self-published keys", "low": "Trusts a single-sided assertion, or cannot distinguish the operator axis from house membership or from agent delegation"}},
      {"name": "claim_verification", "weight": 25, "description": "verify_brand_claim: interpreting the signed response for trust (the brand-judgment gate) and trademark disambiguation. The cryptographic verification itself is an S6 Security skill and is NOT gated here", "scoring_guide": {"high": "Correctly INTERPRETS the signed response for trust — a signature proves authorship not truth, an expired one is audit-only, a failed-verification or mismatched response must be rejected, an unsigned/unverified answer and verification_status alone are not trust-extending — AND disambiguates a trademark across registries/Nice classes. Knowing the response must be verified is required; performing the cryptography is not", "medium": "Interprets the result but misses a trust nuance (does not treat an expired signature as audit-only, or is vague on what a mismatch requires), or trusts verification_status without recognizing the response must be verified", "low": "Treats the unsigned body or the verification_status field as authoritative, would extend trust on an unverified response, or cannot interpret what a valid/expired/tampered/unsigned response means"}},
      {"name": "trust_model_reasoning", "weight": 30, "description": "The knowability framework: the two trust layers (identity vs relationships), direction-asymmetric trust, and what the protocol can vs cannot establish — signature attests authorship not truth, mutual assertion proves consistency not real-world standing", "scoring_guide": {"high": "Separates identity (TLS-verifiable from one document) from relationships (mutual-assertion-gated); explains why a signature proves authorship not truth and why mutual assertion proves consistency not standing; names what the protocol cannot establish (real-world legal standing, withheld internal state, unlinked authorized data, freshness past exp) and the required external cross-checks (registry, DNS/TLS, licensor reciprocation); avoids the directory-vs-trust (managed_by) and standalone-trumps-third-party traps", "medium": "States the direction-asymmetry rule but conflates consistency with standing or treats a signature as proof of truth", "low": "Treats a single owned/licensed response, a valid signature, or mutual assertion as conclusive real-world standing"}}
    ],
    "passing_threshold": 70
  }',
 ARRAY['brand'])
ON CONFLICT (id) DO UPDATE SET
  track_id = EXCLUDED.track_id, title = EXCLUDED.title, description = EXCLUDED.description,
  format = EXCLUDED.format, duration_minutes = EXCLUDED.duration_minutes, sort_order = EXCLUDED.sort_order,
  is_free = EXCLUDED.is_free, prerequisites = EXCLUDED.prerequisites, lesson_plan = EXCLUDED.lesson_plan,
  exercise_definitions = EXCLUDED.exercise_definitions, assessment_criteria = EXCLUDED.assessment_criteria,
  tenant_ids = EXCLUDED.tenant_ids;

-- ── Badge (must exist before the credential's badge_id FK) ────────
INSERT INTO badges (id, name, description, icon, category) VALUES
  ('adcp_specialist_brand', 'AdCP specialist — Brand',
   'Protocol specialist in brand identity and verification — brand.json resolution, distributed publishing and mutual-assertion reciprocity, bilateral adagents.json confirmation, verify_brand_claim signed-response verification, and trademark disambiguation.',
   'specialist', 'certification')
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  icon = EXCLUDED.icon,
  category = EXCLUDED.category;

-- ── Credential (tier 3, requires Practitioner, gated on S7) ───────
INSERT INTO certification_credentials (id, tier, name, description, required_modules, requires_any_track_complete, requires_credential, badge_id, certifier_group_id, sort_order) VALUES
  ('specialist_brand', 3, 'AdCP Specialist — Brand',
   'Protocol specialist in brand identity and verification. Demonstrates mastery of resolving brand.json identity, distributed-publishing mutual assertion, bilateral adagents.json confirmation, verify_brand_claim signed-response verification, and trademark disambiguation through a capstone lab and adaptive exam. The experimental rights lifecycle is taught but not gated.',
   '{S7}', false, 'practitioner', 'adcp_specialist_brand', NULL, 7)
ON CONFLICT (id) DO UPDATE SET
  tier = EXCLUDED.tier,
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  required_modules = EXCLUDED.required_modules,
  requires_any_track_complete = EXCLUDED.requires_any_track_complete,
  requires_credential = EXCLUDED.requires_credential,
  badge_id = EXCLUDED.badge_id,
  certifier_group_id = EXCLUDED.certifier_group_id,
  sort_order = EXCLUDED.sort_order;

-- ── Semantic criterion IDs (define → call → DROP) ─────────────────
-- ID convention: {module}_{exercise}_sc_{concept}. Each is reasoning or
-- hands-on and is executable against the public test agent (verified against
-- the brand tenant + well-known surfaces). The experimental rights lifecycle
-- is deliberately NOT given a gated criterion.
CREATE OR REPLACE FUNCTION _append_criterion(
  p_module_id text,
  p_exercise_id text,
  p_criterion_id text,
  p_text text
) RETURNS void AS $$
DECLARE
  defs jsonb;
  updated jsonb := '[]'::jsonb;
  ex jsonb;
  criteria jsonb;
  already_present boolean;
  exercise_matched boolean := false;
BEGIN
  SELECT exercise_definitions INTO defs
  FROM certification_modules
  WHERE id = p_module_id;

  IF defs IS NULL OR jsonb_typeof(defs) <> 'array' THEN
    RAISE EXCEPTION 'Module % not found or has no exercise_definitions array', p_module_id;
  END IF;

  FOR ex IN SELECT * FROM jsonb_array_elements(defs)
  LOOP
    IF ex->>'id' = p_exercise_id THEN
      exercise_matched := true;
      criteria := COALESCE(ex->'success_criteria', '[]'::jsonb);

      SELECT EXISTS (
        SELECT 1 FROM jsonb_array_elements(criteria) c
        WHERE c->>'id' = p_criterion_id
      ) INTO already_present;

      IF NOT already_present THEN
        criteria := criteria || jsonb_build_array(
          jsonb_build_object('id', p_criterion_id, 'text', p_text)
        );
        ex := jsonb_set(ex, '{success_criteria}', criteria);
      END IF;
    END IF;
    updated := updated || jsonb_build_array(ex);
  END LOOP;

  IF NOT exercise_matched THEN
    RAISE EXCEPTION 'Exercise % not found in module %', p_exercise_id, p_module_id;
  END IF;

  UPDATE certification_modules
  SET exercise_definitions = updated
  WHERE id = p_module_id;
END;
$$ LANGUAGE plpgsql;

SELECT _append_criterion('S7', 's7_ex1', 's7_ex1_sc_resolve_brand_identity',
  'Resolves a brand''s identity via get_brand_identity (and the static brand.json), reads available_fields to detect fields gated to authorized callers, and re-requests authorized=true to obtain colors, fonts, tone, voice, or rights rather than treating the public projection as complete.');

SELECT _append_criterion('S7', 's7_ex1', 's7_ex1_sc_distributed_publishing_reciprocity',
  'Confirms a brand-hierarchy relationship is real by checking BOTH directions — the parent house''s brand_refs[] and the sub-brand''s house_domain back-pointer — and explains why a single-sided assertion is not trust-extending under the mutual-assertion model.');

SELECT _append_criterion('S7', 's7_ex1', 's7_ex1_sc_operator_authorization',
  'Resolves a house''s authorized_operators[] from brand.json and confirms whether an operator (agency, platform, or in-house team) may act for a specific brand by checking domain, brands[] (including the ''*'' wildcard), countries, and scopes[]; distinguishes this buy-side operator-authorization axis from the brand-to-brand house hierarchy (brand_refs[]/house_domain) and from sell-side agent delegation (adagents.json authorized_agents[]), and reasons about how the seller''s require_operator_auth selects the {brand, operator} natural-key vs seller-assigned account_id reference shape.');

SELECT _append_criterion('S7', 's7_ex1', 's7_ex1_sc_bilateral_adagents_confirmation',
  'Bilaterally confirms a delegated sales agent: the publisher''s adagents.json authorizes the agent AND the agent declares itself in its own brand.json — neither side alone is sufficient. Understands that when the publisher pins the agent''s signing keys, the agent''s signed responses are trusted against that publisher pin rather than the agent''s own self-published keys; the cryptographic verification itself is a Security-specialist concern (S6). Rejects an agent the publisher does not list.');

-- The signed_response is gated at the brand-judgment level — interpreting what
-- each verification outcome MEANS for trust. The cryptographic verification
-- itself (kid resolution, canonicalization, signature recompute) is an S6
-- Security skill, deliberately NOT gated here: a Brand specialist is a brand /
-- agency / strategy role, not a cryptographer.
SELECT _append_criterion('S7', 's7_ex1', 's7_ex1_sc_signed_response_trust_interpretation',
  'Interprets a verify_brand_claim response for trust and decides the right action for each outcome: the answer is cryptographically signed by the brand, so a valid signature proves the brand AUTHORED the answer — not that the claim is true, and not a non-repudiation receipt; an expired signature is stale (audit evidence, not a fresh authorization signal); a response that fails verification, or whose signed payload does not match the answer, MUST be rejected; an unsigned or unverified answer — and the verification_status field on its own — is never trust-extending. (Performing the verification is covered in S6 Security; here the gate is knowing what each outcome means for trust.)');

SELECT _append_criterion('S7', 's7_ex1', 's7_ex1_sc_direction_asymmetric_trust',
  'Applies the direction-asymmetric trust rule: treats a single owned / pending_review / licensed_in assertion as informative but NOT trust-extending until the other side reciprocates (parent claim, or licensor licensed_out), while treating not_ours / disputed as authoritative on a single signed response.');

SELECT _append_criterion('S7', 's7_ex1', 's7_ex1_sc_trademark_disambiguation',
  'Disambiguates a trademark claim across jurisdictions: uses registry, number, countries, and nice_classes to resolve a mark that is owned in one registry but disputed or licensed_in in another, narrows an AMBIGUOUS_MATCH, and avoids clearing a creative against the wrong registration.');

SELECT _append_criterion('S7', 's7_ex1', 's7_ex1_sc_identity_drives_generation',
  'Resolves a brand''s generation-relevant identity at the authorized tier (logos, colors, fonts, tone.voice, voice_synthesis, visual_guidelines) and maps each field to its role in on-brand creative generation — distinguishing INPUTS the generator consumes from hard CONSTRAINTS that bound output (tone.dos/donts, visual_guidelines.restrictions, content_restrictions) — and explains why these are exactly the fields get_brand_identity gates behind authorization. Locates the brand/production boundary: the brand agent supplies identity, the rights-gated generation_credentials (provider-enforced, with disclosure + impression cap) and the creative_approval loop ride the EXPERIMENTAL rights lifecycle, and the actual build_creative production belongs to the Creative/Generative specialists.');

SELECT _append_criterion('S7', 's7_ex1', 's7_ex1_sc_trust_knowability',
  'Reasons about the trust framework''s knowability boundary: separates the identity layer (TLS-verifiable from a single brand.json) from the relationship layer (mutual-assertion-gated); explains that a signature attests authorship under the published key within the iat/exp window — not truth, and not non-repudiation — and that mutual assertion proves consistency between two parties, not real-world standing (two attacker-controlled domains can sign matching owned responses); identifies what the protocol cannot establish (real-world legal standing, withheld internal state, unlinked authorized-tier data, freshness past exp) and names the external cross-check or out-of-band check that closes each gap (public registry, DNS/TLS, licensor reciprocation, consumer-side domain-control/legal-entity verification); and avoids the managed_by directory-vs-trust and standalone-trumps-third-party traps.');

DROP FUNCTION _append_criterion(text, text, text, text);
