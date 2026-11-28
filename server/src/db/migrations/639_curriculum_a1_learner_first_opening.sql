-- Open A1 from where the learner is, not from programmatic.
--
-- Every learner starts with A1, and its first concept was framed for ad-tech
-- practitioners: Sage opened by asking what the learner thinks is wrong with
-- programmatic. Learners from policy, government, product, or anywhere outside
-- advertising do not know what programmatic is, and the question loses them
-- before the module starts. This adds a first concept that has Sage ask, in
-- plain words, what the learner does, and teaches a non-industry path that
-- starts with what advertising pays for.
--
-- The demonstration concept also told Sage to "start with a demonstration",
-- which contradicts the teaching rule that tools never run on the first turn;
-- it now runs after the opening. The protocol-hierarchy concept said AdCP is
-- "built on MCP" and then that it runs over MCP and A2A; it now says the
-- second, which is what the spec says.
--
-- Teaching notes only. Criterion IDs, objectives, and assessment criteria are
-- unchanged, so verification already recorded stays valid. Historical
-- migrations (282, 303, 611) stay unchanged.

DO $$
DECLARE
  plan jsonb;
  updated jsonb := '[]'::jsonb;
  concept jsonb;
  demo_matched boolean := false;
  hierarchy_matched boolean := false;
BEGIN
  SELECT lesson_plan INTO plan
  FROM certification_modules
  WHERE id = 'A1';

  IF plan IS NULL OR jsonb_typeof(plan->'key_concepts') <> 'array' THEN
    RAISE EXCEPTION 'Module A1 not found or has no key_concepts array';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(plan->'key_concepts') existing
    WHERE existing->>'topic' = 'Start where the learner is'
  ) THEN
    RETURN;
  END IF;

  FOR concept IN SELECT * FROM jsonb_array_elements(plan->'key_concepts')
  LOOP
    IF concept->>'topic' = 'Agentic vs traditional programmatic' THEN
      demo_matched := true;
      concept := jsonb_set(concept, '{teaching_notes}', to_jsonb($notes$After the opening, run the demonstration on turn 2 or 3: call get_products against @cptestagent and show the learner the result. Walk through the response together in the learner's own terms. Then explain the shift: an agent is given a goal and works out the steps, where today's tools need a person or a fixed integration for each step. For a learner from ad tech, contrast this with programmatic buying they already know. Let the protocol speak for itself before lecturing.$notes$::text));
    ELSIF concept->>'topic' = 'The protocol hierarchy' THEN
      hierarchy_matched := true;
      concept := jsonb_set(concept, '{teaching_notes}', to_jsonb($notes$AdCP defines the advertising tasks and their messages. It runs over two transports: MCP (Model Context Protocol), for AI assistants calling tools, and A2A (Agent2Agent), for agents working with each other. Same tasks, same schemas, different transport. Keep this brief: the point is that AdCP is not tied to one way of connecting.$notes$::text));
    END IF;
    updated := updated || jsonb_build_array(concept);
  END LOOP;

  IF NOT demo_matched THEN
    RAISE EXCEPTION 'A1 key concept "Agentic vs traditional programmatic" not found';
  END IF;
  IF NOT hierarchy_matched THEN
    RAISE EXCEPTION 'A1 key concept "The protocol hierarchy" not found';
  END IF;

  updated := jsonb_build_array(jsonb_build_object(
    'topic', 'Start where the learner is',
    'teaching_notes', $notes$First ask, in plain words, what the learner does and how close it is to advertising. Use no industry terms (programmatic, DSP, SSP, ad tech) until you know. Many A1 learners work in policy, law, government, product, investment, or education and have never bought or sold an ad.

If they work in advertising or ad tech, start in their world: ask what they find broken or slow about how media is bought and sold today, then show the demo.

If they don't, build from what they already know. Start with what advertising pays for: free news, apps, video, podcasts, and search. Then explain that software agents are starting to buy and sell that advertising for brands and publishers, which raises real questions: who allowed the agent to act, how much it may spend, and what it may say about a brand. Then place AdCP: an open, shared way for those agents to talk, so the rules can be inspected instead of hidden inside each company's systems. Introduce the word "programmatic" only when it helps, define it in one sentence (most online ads are bought today by automated auctions that run in milliseconds), and never ask the learner to judge it.

A learner new to advertising meets the conceptual-understanding dimension by explaining what agents change about how advertising is bought and sold; industry vocabulary is not required. If the learner says they decide or advise rather than build, mention once that the free Decision-makers track (L1 to L3) is written for non-technical leaders, and carry on with A1 if they want to.$notes$::text
  )) || updated;

  UPDATE certification_modules
  SET lesson_plan = jsonb_set(plan, '{key_concepts}', updated)
  WHERE id = 'A1';
END;
$$;
