-- Seed the S6 (Security) specialist module so it can be earned as a credential.
--
-- S6 tests mastery of AdCP's five-layer defense model (identity, isolation,
-- idempotency, signed governance, auditability) from the security-operator /
-- own-issuance perspective. It is the security analog of the other S-track
-- specialists (S1 media buy, S2 creative, S3 signals, S4 governance, S5
-- generative): track 'S', format 'capstone', prerequisite A3, tier-3 credential
-- gated behind 'practitioner'.
--
-- Curriculum source of record: docs/learning/specialist/security.mdx.
-- Every gated criterion tests reasoning ("explain what this control closes")
-- or a hands-on outcome the public test agent can actually produce. Criteria
-- that would require a scenario the sandbox cannot demonstrate in a single
-- session (the 24h idempotency-TTL expiry, a pre-revoked governance key) are
-- framed as reasoning about the mechanism rather than as an un-producible
-- demonstration.
--
-- S4/S6 overlap: S4 (Governance) gates governance *authorization* decisions
-- (check_governance approve/deny/conditions, GOVERNANCE_DENIED recovery,
-- governance_context correlation, purchase_type variation). S6 does NOT
-- re-gate those. S6's governance criteria cover the cryptographic
-- verification / own-issuance angle — what each JWS step closes and the
-- fail-closed (FM-7) and revocation mechanics — which S4 never gates.

-- ── Module row (must exist before any _append_criterion('S6', ...)) ──────────
INSERT INTO certification_modules
  (id, track_id, title, description, format, duration_minutes, sort_order, is_free, prerequisites, lesson_plan, exercise_definitions, assessment_criteria)
VALUES
('S6', 'S', 'Security',
 'AdCP''s five-layer defense model in practice: identity, tenant isolation, idempotency semantics, signed governance verification, SSRF discipline, and operational incident response. Tested from the security-operator perspective — reasoning about which control closes each threat and demonstrating the controls a learner can exercise against the sandbox.',
 'capstone', 60, 6, false, '{A3}',
 '{
    "objectives": [
      "Map each agentic-advertising threat to the specific AdCP control that closes it, and explain why no single layer is sufficient",
      "Demonstrate idempotency semantics on a mutating call and reason about the side effects of each outcome",
      "Reason about signed-governance verification (the JWS checklist, fail-closed behavior, and revocation) from the operator''s own-issuance perspective",
      "Specify the SSRF discipline on outbound fetches and what each check closes",
      "Explain the principal-isolation model and design an operational incident-response runbook"
    ],
    "key_concepts": [
      {"topic": "Five-layer defense model", "teaching_notes": "Identity (who is calling — auth declarations, OAuth/RFC 9728 audience binding), isolation (account-scoped access so one principal cannot read another''s resources), idempotency (at-most-once side effects on mutating calls via a replay-windowed key), signed governance (cryptographically verified governance tokens), and auditability (tamper-evident logs). Each layer closes a distinct attack; defense-in-depth means a failure in one layer is still contained by the others. Teach learners to name the attack each layer closes, not to recite the list."},
      {"topic": "Idempotency semantics", "teaching_notes": "A mutating call carries an idempotency_key. First call succeeds; an identical replay returns the cached result with replayed:true and no new side effect; the same key with a different payload returns IDEMPOTENCY_CONFLICT (payload equivalence is a JCS/RFC 8785 canonical hash); after the replay window (TTL) lapses the key is forgotten. The sandbox TTL is 24h, so expiry is reasoned about, not observed in a lab. A missing key on a mutating call removes the at-most-once guarantee — a retried network call can double-apply its side effect (e.g. double-spend on a financial commit)."},
      {"topic": "Signed governance verification", "teaching_notes": "Governance tokens are JWS-signed. Verification is a fixed checklist: alg allowlist (no alg:none/downgrade), typ match, SSRF-validated JWKS fetch, aud/sub/phase binding (confused-deputy and phase-confusion defense), jti replay dedup, and a revocation-list check (signed revoked_kids/revoked_jtis, polled on a next_update cadence) done before the token is trusted. FM-7: if the JWKS fetch fails, verification MUST fail closed — never fall back to a bare iss claim. S6 covers this from the operator''s own-issuance-correctness angle; S4 covers seller authorization decisions (approve/deny/conditions)."},
      {"topic": "SSRF discipline on outbound fetches", "teaching_notes": "Any buyer-supplied URL the agent fetches (webhook push_notification_config.url, asset URLs) is an SSRF vector. The discipline: HTTPS/scheme allowlist, a reserved-IP deny list (loopback, RFC1918, link-local 169.254.0.0/16 incl. the 169.254.169.254 cloud-metadata endpoint), IP-pin validation at connect time (closes DNS rebinding between validation and dial), redirect suppression (a 30x to a reserved IP cannot bypass the check), size/timeout caps, and suppressed error detail so the response is not an oracle for internal reachability."},
      {"topic": "Isolation and incident response", "teaching_notes": "Account-scoped tokens keep one principal''s resources invisible to another on the same seller; without that scoping, a token leak becomes cross-tenant data exposure. Operationally: a leaked credential triggers a runbook — rotate in the right order (mint new, cut over, revoke old) to avoid both a lockout and an open window, notify counterparties, review the audit trail to bound the compromise window, and rotate webhook secrets and governance keys as their own procedures."}
    ],
    "discussion_prompts": [
      "Pick one defense layer, remove it, and trace exactly which attack now succeeds end-to-end.",
      "A retried create_media_buy with no idempotency_key — what is the worst-case side effect, and which response field would have prevented it?",
      "Why is checking the revocation list before trusting a signature, rather than after, the safer order?",
      "An incident report says a governance token was accepted after its key was revoked. Which layer failed and what is the single control you harden?"
    ],
    "demo_scenarios": [
      {
        "description": "Open with a live SSRF block (the most visceral control to see first). Call sync_accounts with dry_run true and a unique idempotency_key, registering one sandbox account (brand.domain, operator, billing operator, sandbox true) with TWO notification_configs: a webhook url https://169.254.169.254/latest/meta-data/ (the cloud-metadata address) and a control url https://webhook.example.com/notify.",
        "tools": ["sync_accounts"],
        "expected_outcome": "The metadata target is refused synchronously — a VALIDATION_ERROR on notification_configs[].url with the message about the SSRF guard refusing a literal private or loopback address — while the public host is accepted (action created). The hook: the agent refuses to be turned into an SSRF weapon against cloud-instance metadata, and it does so at registration, not later at delivery."
      },
      {
        "description": "Idempotency lifecycle on ONE key. Call create_property_list three times reusing a single idempotency_key (any unique string of 16+ chars): (a) with a name; (b) identical args; (c) same key but a changed name.",
        "tools": ["create_property_list"],
        "expected_outcome": "(a) returns a list_id; (b) returns the SAME list_id with replayed true and unchanged created_at (no new side effect); (c) returns IDEMPOTENCY_CONFLICT. Use the replay to show at-most-once, and the conflict envelope (only non-payload-derived fields — never the stored payload) to teach the read-oracle defense."
      },
      {
        "description": "Obtain and decode a real signed governance token (use the /governance tenant). First sync_plans with a COMPLETE plan or it is rejected: plan_id, brand.domain pinnacle-agency.example, objectives, budget (total, currency, and reallocation_unlimited true), flight (start and end), countries US; plus a top-level account with brand.domain acmeoutdoor.example and an idempotency_key. Then check_governance with the SAME plan_id, a caller, the SAME account, tool create_media_buy, phase intent, and a payload within budget and countries.",
        "tools": ["sync_plans", "check_governance"],
        "expected_outcome": "check_governance returns status approved with a governance_context — a signed adcp-gov+jws JWS. Base64url-decode its header (alg EdDSA, typ, kid) and claims (aud, sub equals plan_id, phase, jti, exp) to anchor the 15-step verification in a real token. Gotchas to avoid: budget MUST include reallocation_unlimited (or a reallocation_threshold) and the plan MUST include flight, or sync_plans returns VALIDATION_ERROR; the account brand.domain must match between sync_plans and check_governance or the check denies and returns no token."
      }
    ]
  }',
 '[
    {
      "id": "s6_ex1",
      "title": "Threat model and layered defense",
      "description": "Map each agentic-advertising threat to the specific AdCP control that closes it, and reason about defense-in-depth.",
      "sandbox_actions": [
        {"tool": "get_adcp_capabilities", "guidance": "Read the agent''s declared capabilities and auth requirements to ground the threat-to-control mapping in what this agent actually advertises."}
      ],
      "success_criteria": []
    },
    {
      "id": "s6_ex2",
      "title": "Idempotency lifecycle",
      "description": "Use one idempotency_key on a mutating call to produce the success, replay, and conflict outcomes, and reason about expiry and a missing key.",
      "sandbox_actions": [
        {"tool": "create_property_list", "guidance": "Call once with a unique idempotency_key and a name (success); replay the identical call (replayed:true, same list_id — no new side effect); then reuse the key with a changed name/description (IDEMPOTENCY_CONFLICT)."}
      ],
      "success_criteria": []
    },
    {
      "id": "s6_ex3",
      "title": "Signed governance verification",
      "description": "Obtain and decode a real signed governance token, then reason about the JWS verification checklist, fail-closed behavior, and revocation from the security-operator / own-issuance perspective.",
      "sandbox_actions": [
        {"tool": "sync_plans", "guidance": "Register a complete campaign plan so the governance agent can approve against it — it must include brand{domain}, objectives, budget{total, currency, and reallocation_unlimited:true or a reallocation_threshold}, flight{start, end}, and countries, plus a top-level account{brand{domain}} and idempotency_key. An incomplete plan returns VALIDATION_ERROR."},
        {"tool": "check_governance", "guidance": "Run an intent-phase check against the plan to obtain a signed governance token (the governance_context JWS), then decode its header and claims. Focus on the cryptographic-verification steps and what each closes — not the approve/deny authorization decision (that is S4)."}
      ],
      "success_criteria": []
    },
    {
      "id": "s6_ex4",
      "title": "SSRF discipline",
      "description": "Demonstrate that the agent refuses to register a webhook target that would enable SSRF, and explain what each point of the outbound-fetch check closes.",
      "sandbox_actions": [
        {"tool": "sync_accounts", "guidance": "Register a notification_config whose webhook url targets the cloud-metadata address (https://169.254.169.254/latest/meta-data/) and a second targeting a public host; observe that the metadata target is refused synchronously by the SSRF guard while the public host is accepted. Then predict and verify what changes if the same metadata IP is given over http:// instead of https://."}
      ],
      "success_criteria": []
    },
    {
      "id": "s6_ex5",
      "title": "Principal isolation",
      "description": "Explain the account-scoped isolation model and what breaks without it.",
      "sandbox_actions": [
        {"tool": "list_accounts", "guidance": "List the accounts visible to the authenticated agent and reason about how account-scoping bounds what any one principal can read."}
      ],
      "success_criteria": []
    },
    {
      "id": "s6_ex6",
      "title": "Incident runbook design",
      "description": "Design the response to a credential-compromise incident: rotation order, counterparty notification, and bounding the compromise window.",
      "sandbox_actions": [
        {"tool": "get_adcp_capabilities", "guidance": "Use the agent''s declared auth and webhook surfaces to ground a concrete rotation and notification plan."}
      ],
      "success_criteria": []
    },
    {
      "id": "s6_ex7",
      "title": "Defense-layer diagnosis",
      "description": "Given incident descriptions, identify which defense layer failed and the specific control to harden.",
      "sandbox_actions": [
        {"tool": "get_adcp_capabilities", "guidance": "Ground each diagnosis in the controls the agent declares so the hardening recommendation is specific, not generic."}
      ],
      "success_criteria": []
    }
  ]',
 '{
    "dimensions": [
      {"name": "threat_model_fluency", "weight": 20, "description": "Maps each named attack to the specific AdCP layer that closes it, reasons about defense-in-depth, and explains the principal-isolation model (including the difference between a session/account-scoped not-found and an authorization denial)", "scoring_guide": {"high": "Maps every named threat to its closing control, explains with a concrete end-to-end example why no single layer is sufficient, and articulates the account-scoped isolation model and what breaks without it.", "medium": "Maps most threats to controls but cannot articulate defense-in-depth or the isolation model.", "low": "Recites the threat or layer list without connecting attacks to controls."}},
      {"name": "hands_on_idempotency", "weight": 20, "description": "Produces the observable idempotency outcomes on a mutating call and reasons about the rest", "scoring_guide": {"high": "Produces success, an idempotent replay (replayed:true, unchanged resource), and IDEMPOTENCY_CONFLICT on demand, and reasons correctly about expiry and a missing key.", "medium": "Produces some outcomes but cannot explain the conflict hash or the missing-key side effect.", "low": "Cannot produce the idempotency outcomes."}},
      {"name": "governance_verification", "weight": 25, "description": "Reasons about JWS verification, fail-closed behavior, and revocation from the operator perspective", "scoring_guide": {"high": "Names what each key JWS step closes, explains FM-7 fail-closed and why bare-iss fallback is forbidden, and describes the revocation check and its ordering.", "medium": "Knows the steps exist but cannot connect each to the attack it closes.", "low": "Cannot explain why signature verification or revocation matters."}},
      {"name": "ssrf_discipline", "weight": 15, "description": "Specifies the SSRF check on outbound fetches and what each point closes", "scoring_guide": {"high": "Specifies the full SSRF check and explains the cloud-metadata and DNS-rebinding cases and how IP-pin-at-connect plus no-redirect-follow close them.", "medium": "Lists most checks but misses rebinding or redirect bypass.", "low": "Cannot specify an SSRF check."}},
      {"name": "operational_design", "weight": 20, "description": "Designs a credential-compromise runbook and diagnoses which layer failed in an incident", "scoring_guide": {"high": "Sequences rotation correctly, specifies counterparty notification and audit-window bounding, and diagnoses the failed layer plus the specific control to harden for each incident.", "medium": "Produces a partial runbook or a generic diagnosis.", "low": "Cannot design a runbook or diagnose a failure."}}
    ],
    "passing_threshold": 70
  }')
ON CONFLICT (id) DO UPDATE SET
  track_id = EXCLUDED.track_id, title = EXCLUDED.title, description = EXCLUDED.description,
  format = EXCLUDED.format, duration_minutes = EXCLUDED.duration_minutes, sort_order = EXCLUDED.sort_order,
  is_free = EXCLUDED.is_free, prerequisites = EXCLUDED.prerequisites, lesson_plan = EXCLUDED.lesson_plan,
  exercise_definitions = EXCLUDED.exercise_definitions, assessment_criteria = EXCLUDED.assessment_criteria;

-- ── Badge (must exist before the credential — certification_credentials.badge_id FK) ──
INSERT INTO badges (id, name, description, icon, category) VALUES
  ('adcp_specialist_security', 'AdCP specialist — Security', 'Protocol specialist in AdCP''s five-layer defense model: identity, isolation, idempotency, signed governance, and SSRF discipline, plus operational incident response', 'specialist', 'certification')
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  icon = EXCLUDED.icon,
  category = EXCLUDED.category;

-- ── Credential (tier 3, requires practitioner, gated on the S6 module) ──
INSERT INTO certification_credentials
  (id, tier, name, description, required_modules, requires_any_track_complete, requires_credential, badge_id, certifier_group_id, sort_order)
VALUES
  ('specialist_security', 3, 'AdCP Specialist — Security',
   'Protocol specialist in AdCP security. Demonstrates mastery of the five-layer defense model — identity, isolation, idempotency, signed governance, and SSRF discipline — and operational incident response through capstone lab and adaptive exam.',
   '{S6}', false, 'practitioner', 'adcp_specialist_security', NULL, 8)
ON CONFLICT (id) DO UPDATE SET
  tier = EXCLUDED.tier,
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  required_modules = EXCLUDED.required_modules,
  requires_any_track_complete = EXCLUDED.requires_any_track_complete,
  requires_credential = EXCLUDED.requires_credential,
  badge_id = EXCLUDED.badge_id,
  sort_order = EXCLUDED.sort_order;

-- ── Semantic criterion IDs (define → call → DROP; idempotent via the in-function
--    already_present check). Every criterion is a {id,text} object; the module
--    above seeds empty success_criteria arrays so no string criteria ever exist. ──
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

-- ex1 — Threat model and layered defense (reasoning)
SELECT _append_criterion('S6', 's6_ex1', 's6_ex1_sc_threat_to_control_map',
  'Maps each named threat — credential theft, replay, cross-tenant leakage, SSRF, spoofed identity, unauthorized governance-token use, audit tampering — to the specific AdCP control that closes it, rather than reciting the threat list.');
SELECT _append_criterion('S6', 's6_ex1', 's6_ex1_sc_defense_in_depth',
  'Explains why no single layer is sufficient by tracing a concrete case where one layer fails and naming the layer that still contains the attack.');

-- ex2 — Idempotency lifecycle (hands-on, verified live against the test agent)
SELECT _append_criterion('S6', 's6_ex2', 's6_ex2_sc_success_and_replay',
  'Produces a successful first call and an identical replay on the same idempotency_key, and shows from the response — replayed:true with an unchanged resource id and timestamps — that the replay caused no new side effect.');
SELECT _append_criterion('S6', 's6_ex2', 's6_ex2_sc_conflict_on_changed_payload',
  'Triggers IDEMPOTENCY_CONFLICT by reusing the key with a changed payload, explains that payload equivalence is a canonical (JCS) hash, why the conflict envelope carries only non-payload-derived fields (code, message, and routing/correlation metadata) and never any payload-derived detail (which would turn key reuse into a read oracle), and the correct recovery: resend the identical payload to get the cached result, or mint a fresh key for the new payload.');
SELECT _append_criterion('S6', 's6_ex2', 's6_ex2_sc_expiry_and_missing_key',
  'Reasons about the replay-window/TTL expiry outcome and explains what a missing idempotency_key removes — the seller''s at-most-once guarantee — so a retried mutating call can double-apply its side effect.');

-- ex3 — Signed governance verification (one hands-on + reasoning; security-operator /
--        own-issuance angle, deliberately NOT re-gating S4's authorization decisions).
--        Hands-on obtain+decode is verified live (sync_plans -> check_governance returns a
--        signed adcp-gov+jws token). The agent is a token ISSUER, not a verifier, so tamper-
--        and-revocation REJECTION are NOT live-observable and are framed as reasoning, not as
--        an un-producible demonstration. See the report for the verifier/JWKS/revoked-kid
--        fixtures that would make those steps hands-on.
SELECT _append_criterion('S6', 's6_ex3', 's6_ex3_sc_obtain_and_decode_token',
  'Obtains a signed governance token from the sandbox (sync_plans then an intent-phase check_governance) and decodes it, reading the actual token rather than describing one in the abstract: identifies the header alg, typ, and kid and the aud, sub, phase, jti, and exp claims that the verification checklist binds.');
SELECT _append_criterion('S6', 's6_ex3', 's6_ex3_sc_jws_steps_what_each_closes',
  'Using the decoded token and the spec, walks the JWS verification checklist and, for the key steps — alg allowlist, typ match, SSRF-validated JWKS fetch, aud/sub/phase binding, jti replay dedup, revocation check — names the specific attack each step closes, from the operator''s own-issuance-correctness perspective.');
SELECT _append_criterion('S6', 's6_ex3', 's6_ex3_sc_fail_closed_jwks',
  'Explains why governance-token JWS verification must fail closed when the JWKS fetch fails (15-step checklist step 5) and must never fall back to a bare iss claim, what spoofing a bare-iss fallback would enable, and that the same fail-closed discipline is FM-7 for the separate RFC 9421 request-signing profile.');
SELECT _append_criterion('S6', 's6_ex3', 's6_ex3_sc_revocation_mechanics',
  'Explains the revocation mechanism — a signed revoked_kids/revoked_jtis list polled on a next_update cadence — and why an operator checks revocation as part of, not after, deciding to trust a token.');

-- ex4 — SSRF discipline (one hands-on + reasoning). The registration block is verified live:
--        sync_accounts on the production agent (NODE_ENV=production -> allowPrivateIp=false)
--        refuses a notification_config url pointed at https://169.254.169.254/ synchronously
--        with VALIDATION_ERROR "url rejected by SSRF guard: literal private/loopback address",
--        while a public host is accepted.
SELECT _append_criterion('S6', 's6_ex4', 's6_ex4_sc_register_blocked_webhook',
  'Registers a notification_config webhook target on the cloud-metadata address (https://169.254.169.254/...) via sync_accounts and shows the synchronous refusal — a VALIDATION_ERROR on notification_configs[].url — then contrasts it with an accepted public host, and explains why an https metadata target is refused by the SSRF guard while the same address over http is refused earlier by the HTTPS-enforcement check at registration (url must use HTTPS).');
SELECT _append_criterion('S6', 's6_ex4', 's6_ex4_sc_outbound_fetch_checks',
  'Specifies the SSRF check applied to a buyer-supplied outbound-fetch URL — scheme/HTTPS allowlist, reserved-IP and cloud-metadata deny list, IP-pin validation at connect, redirect suppression, size/timeout caps, suppressed error detail — and names what each point closes.');
SELECT _append_criterion('S6', 's6_ex4', 's6_ex4_sc_metadata_and_rebinding',
  'Explains why the cloud-metadata endpoint (169.254.169.254) and DNS rebinding are the high-value SSRF targets, and how IP-pin-at-connect plus no-redirect-follow close the rebinding and redirect-bypass paths.');

-- ex5 — Principal isolation (reasoning). A true two-principal probe is not possible on the
--        shared public token (one principal; resources are partitioned by an account-keyed
--        session, not an authenticated access-control check), so the criterion tests the
--        trust-model reasoning — including the sharp not-found-vs-denied distinction — rather
--        than over-claiming an observed block.
SELECT _append_criterion('S6', 's6_ex5', 's6_ex5_sc_isolation_model',
  'Explains the account-scoped isolation model — how a principal''s resources stay invisible to another on the same seller — distinguishes a session/account-scoped not-found from an authorization denial when a read is scoped to a different account, and states what specifically breaks (cross-tenant read/write on a leaked token) if account-scoped access were not enforced.');

-- ex6 — Incident runbook design (reasoning)
SELECT _append_criterion('S6', 's6_ex6', 's6_ex6_sc_rotation_order',
  'Designs a credential-compromise runbook (API key leaked in a public repo) that sequences rotation correctly — mint and cut over before revoking — so the response neither locks out legitimate callers nor leaves an open window.');
SELECT _append_criterion('S6', 's6_ex6', 's6_ex6_sc_comms_and_window',
  'Specifies which counterparties to notify, which audit events to review, and how to bound the compromise window, and treats webhook-secret and governance-key rotation as their own procedures.');

-- ex7 — Defense-layer diagnosis (reasoning)
SELECT _append_criterion('S6', 's6_ex7', 's6_ex7_sc_diagnose_failed_layer',
  'Given each incident — a replay succeeded, cross-tenant data was returned, a governance token was accepted after key revocation — identifies which defense layer failed and names the specific control to harden, distinctly for each case rather than generically.');

DROP FUNCTION _append_criterion(text, text, text, text);
