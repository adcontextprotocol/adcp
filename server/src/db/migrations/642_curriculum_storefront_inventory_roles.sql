-- Teach the two jobs behind a sales agent: storefront and inventory.
--
-- RFC adcontextprotocol/adcp#8993 (4.0 milestone) names two roles a sales
-- agent can play. A storefront agent faces buyers: it answers briefs, proposes,
-- negotiates, and packages, and books through inventory agents over AdCP. An
-- inventory agent holds the catalogue and avails, executes media buys, and
-- reports delivery. Proposal work is a storefront capability, not a third kind
-- of agent. Nothing in 3.3 is normative about this; the public test agent
-- already serves two inventory tenants for testing storefronts.
--
-- B1, where the seller path designs its agent, gets the concept and a
-- discussion prompt. A3, which every learner takes, names it at survey depth.
-- B1 also called the product catalog "your storefront"; that now collides with
-- the role name, so the catalog wording changes. Taught, not graded: no
-- success criterion is added, and no role field, capability, or specialism is
-- taught as if it exists.

DO $$
DECLARE
  plan jsonb;
  defs jsonb;
  concepts jsonb := '[]'::jsonb;
  concept jsonb;
  anchored boolean := false;
  role_topic text := 'Two jobs behind a sales agent: storefront and inventory (non-normative)';
  role_notes text := $notes$Non-normative in 3.3; the roles are being standardized for 4.0 in RFC #8993. A seller's agents do two different jobs. A storefront agent faces buyers: it answers briefs, chooses what fits, prices it, writes and negotiates proposals, and packages inventory that may come from several systems. It books by calling one or more inventory agents, as their buyer, over AdCP. An inventory agent faces the inventory: it holds the catalogue and avails, executes media buys in the system that serves them, and reports delivery. Proposal work (request_proposals, refine_proposals) is something a storefront does, not a third kind of agent.

Most sellers have one buyer-facing team and several inventory systems: display and video on an ad server, a podcast on a hosting platform, creator deals somewhere else. Each system can sit behind an inventory agent, and one storefront can sell across them. That is why the jobs separate: an ad server vendor can ship the inventory agent while a publisher, agency, or marketplace runs the storefront, and a buyer can see whose system booked a package and whose numbers a delivery report carries.

Today's single sales agent plays both roles and stays valid; nothing in 3.3 requires the split. If the learner builds with @adcp/sdk, its ProposalManager (proposals) and DecisioningPlatform (execution and delivery) already make this split inside one agent. RFC #8993 is still settling how an agent declares its role and how a storefront names its inventory agents, so do not teach a role field, capability, or specialism as if it exists, and do not grade this. The public test agent's two inventory tenants play the inventory role, and a storefront can book through both: /docs/building/verification/simulated-inventory-agents.$notes$;
  role_prompt text := 'Your publisher sells display and video through an ad server, a weekly podcast through a hosting platform, and creator sponsorships by hand. Which agent faces buyers, which agents hold inventory, and what should a buyer be able to see when one package in a buy goes live late?';
BEGIN
  SELECT lesson_plan, exercise_definitions INTO plan, defs
  FROM certification_modules
  WHERE id = 'B1';

  IF plan IS NULL OR jsonb_typeof(plan->'key_concepts') <> 'array' THEN
    RAISE EXCEPTION 'Module B1 not found or has no key_concepts array';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(plan->'key_concepts') existing
    WHERE existing->>'topic' = role_topic
  ) THEN
    FOR concept IN SELECT * FROM jsonb_array_elements(plan->'key_concepts')
    LOOP
      IF concept->>'topic' = 'Product catalog design' THEN
        anchored := true;
        concept := jsonb_set(concept, '{teaching_notes}', to_jsonb(replace(
          concept->>'teaching_notes',
          'The catalog is your storefront.',
          'The catalog is what buyer agents shop from.'
        )));
        concepts := concepts || jsonb_build_array(concept)
          || jsonb_build_array(jsonb_build_object('topic', role_topic, 'teaching_notes', role_notes));
      ELSE
        concepts := concepts || jsonb_build_array(concept);
      END IF;
    END LOOP;

    IF NOT anchored THEN
      RAISE EXCEPTION 'B1 key concept "Product catalog design" not found';
    END IF;

    plan := jsonb_set(plan, '{key_concepts}', concepts);
  END IF;

  IF NOT COALESCE(plan->'discussion_prompts', '[]'::jsonb) @> jsonb_build_array(role_prompt) THEN
    plan := jsonb_set(plan, '{discussion_prompts}',
      COALESCE(plan->'discussion_prompts', '[]'::jsonb) || jsonb_build_array(role_prompt));
  END IF;

  IF defs IS NULL OR jsonb_typeof(defs) <> 'array' THEN
    RAISE EXCEPTION 'Module B1 has no exercise_definitions array';
  END IF;

  defs := (
    SELECT jsonb_agg(
      CASE WHEN ex->>'id' = 'b1_ex1' AND ex->>'title' = 'Build your storefront'
        THEN jsonb_set(ex, '{title}', to_jsonb('Design your catalog'::text))
        ELSE ex
      END ORDER BY ordinality)
    FROM jsonb_array_elements(defs) WITH ORDINALITY AS e(ex, ordinality)
  );

  UPDATE certification_modules
  SET lesson_plan = plan,
      exercise_definitions = defs
  WHERE id = 'B1';
END;
$$;

DO $$
DECLARE
  plan jsonb;
  concepts jsonb := '[]'::jsonb;
  concept jsonb;
  matched boolean := false;
  addition text := $notes$Also name, in two sentences, the two jobs a seller's agents can do: a storefront agent faces buyers (answers briefs, proposes, negotiates, and packages) and books through inventory agents, which hold the catalogue and avails, execute buys, and report delivery. Today one sales agent usually does both; the split is non-normative in 3.3 and being standardized for 4.0 (RFC #8993), and B1 covers it.$notes$;
BEGIN
  SELECT lesson_plan INTO plan
  FROM certification_modules
  WHERE id = 'A3';

  IF plan IS NULL OR jsonb_typeof(plan->'key_concepts') <> 'array' THEN
    RAISE EXCEPTION 'Module A3 not found or has no key_concepts array';
  END IF;

  FOR concept IN SELECT * FROM jsonb_array_elements(plan->'key_concepts')
  LOOP
    IF concept->>'topic' = 'Sell-side identity and authorization' THEN
      matched := true;
      IF position(addition IN concept->>'teaching_notes') = 0 THEN
        concept := jsonb_set(concept, '{teaching_notes}',
          to_jsonb((concept->>'teaching_notes') || ' ' || addition));
      END IF;
    END IF;
    concepts := concepts || jsonb_build_array(concept);
  END LOOP;

  IF NOT matched THEN
    RAISE EXCEPTION 'A3 key concept "Sell-side identity and authorization" not found';
  END IF;

  UPDATE certification_modules
  SET lesson_plan = jsonb_set(plan, '{key_concepts}', concepts)
  WHERE id = 'A3';
END;
$$;
