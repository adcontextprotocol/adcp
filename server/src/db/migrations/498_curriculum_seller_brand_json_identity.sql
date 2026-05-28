-- Migration 498: clarify seller-side brand.json identity in Academy curriculum.
--
-- Issue #5094 exposed a training/docs gap: brand.json was often described as
-- buyer/advertiser identity, while seller/publisher/platform use was implied.
-- This migration aligns certification lesson plans with the docs:
--   - brand.json is the public organization identity record for advertisers,
--     publishers, sellers, and platforms; it also supports agent and signing-key
--     discovery.
--   - adagents.json is the publisher authorization record for properties and the
--     agents authorized to sell or enrich inventory.
--   - supply-path verification is bilateral: the operator claims the sales path
--     in brand.json and the publisher confirms authorization in adagents.json.

BEGIN;

CREATE OR REPLACE FUNCTION _append_lesson_objective(
  p_module_id text,
  p_objective text
) RETURNS void AS $$
DECLARE
  lp jsonb;
  objectives jsonb;
BEGIN
  SELECT lesson_plan INTO lp
  FROM certification_modules
  WHERE id = p_module_id;

  IF lp IS NULL THEN
    RAISE EXCEPTION 'Module % not found or has no lesson_plan', p_module_id;
  END IF;

  objectives := COALESCE(lp->'objectives', '[]'::jsonb);

  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(objectives) existing(value)
    WHERE existing.value = p_objective
  ) THEN
    UPDATE certification_modules
    SET lesson_plan = jsonb_set(
      lesson_plan,
      '{objectives}',
      objectives || jsonb_build_array(p_objective),
      true
    )
    WHERE id = p_module_id;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION _replace_or_append_key_concept(
  p_module_id text,
  p_topic text,
  p_teaching_notes text
) RETURNS void AS $$
DECLARE
  lp jsonb;
  concepts jsonb;
  updated jsonb := '[]'::jsonb;
  concept jsonb;
  matched boolean := false;
BEGIN
  SELECT lesson_plan INTO lp
  FROM certification_modules
  WHERE id = p_module_id;

  IF lp IS NULL THEN
    RAISE EXCEPTION 'Module % not found or has no lesson_plan', p_module_id;
  END IF;

  concepts := COALESCE(lp->'key_concepts', '[]'::jsonb);

  FOR concept IN SELECT * FROM jsonb_array_elements(concepts)
  LOOP
    IF concept->>'topic' = p_topic THEN
      matched := true;
      concept := concept - 'explanation';
      concept := jsonb_set(concept, '{teaching_notes}', to_jsonb(p_teaching_notes), true);
    END IF;
    updated := updated || jsonb_build_array(concept);
  END LOOP;

  IF NOT matched THEN
    updated := updated || jsonb_build_array(
      jsonb_build_object('topic', p_topic, 'teaching_notes', p_teaching_notes)
    );
  END IF;

  UPDATE certification_modules
  SET lesson_plan = jsonb_set(lesson_plan, '{key_concepts}', updated, true)
  WHERE id = p_module_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION _append_to_key_concept_notes(
  p_module_id text,
  p_topic text,
  p_suffix text,
  p_presence_check text
) RETURNS void AS $$
DECLARE
  lp jsonb;
  concepts jsonb;
  updated jsonb := '[]'::jsonb;
  concept jsonb;
  matched boolean := false;
  existing_notes text;
BEGIN
  SELECT lesson_plan INTO lp
  FROM certification_modules
  WHERE id = p_module_id;

  IF lp IS NULL THEN
    RAISE EXCEPTION 'Module % not found or has no lesson_plan', p_module_id;
  END IF;

  concepts := COALESCE(lp->'key_concepts', '[]'::jsonb);

  FOR concept IN SELECT * FROM jsonb_array_elements(concepts)
  LOOP
    IF concept->>'topic' = p_topic THEN
      matched := true;
      existing_notes := COALESCE(concept->>'teaching_notes', concept->>'explanation', '');
      concept := concept - 'explanation';
      IF existing_notes NOT ILIKE '%' || p_presence_check || '%' THEN
        concept := jsonb_set(
          concept,
          '{teaching_notes}',
          to_jsonb(trim(both ' ' from existing_notes || ' ' || p_suffix)),
          true
        );
      ELSE
        concept := jsonb_set(concept, '{teaching_notes}', to_jsonb(existing_notes), true);
      END IF;
    END IF;
    updated := updated || jsonb_build_array(concept);
  END LOOP;

  IF NOT matched THEN
    RAISE EXCEPTION 'Key concept % not found in module %', p_topic, p_module_id;
  END IF;

  UPDATE certification_modules
  SET lesson_plan = jsonb_set(lesson_plan, '{key_concepts}', updated, true)
  WHERE id = p_module_id;
END;
$$ LANGUAGE plpgsql;

-- Foundations: A2 and A3 should introduce both discovery files without making
-- brand.json sound advertiser-only.
SELECT _append_lesson_objective(
  'A2',
  'Distinguish brand.json as organization identity from adagents.json as publisher authorization'
);

SELECT _replace_or_append_key_concept(
  'A2',
  'Discovery files',
  'Teach the two well-known files together. brand.json is the public organization identity record for an advertiser, publisher, seller, or platform: name, logo, domains, sales or brand agents, and signing-key discovery. adagents.json is hosted by publishers to declare properties and which agents are authorized to sell or enrich inventory. In a supply-path check, buyer agents use both files, not one or the other.'
);

SELECT _append_lesson_objective(
  'A3',
  'Describe how brand.json and adagents.json work together for sell-side trust'
);

SELECT _replace_or_append_key_concept(
  'A3',
  'Sell-side identity and authorization',
  'Cover brand.json as a company record, not just an advertiser record. Publishers, sellers, networks, and platforms use it for public identity, agent declarations, property relationships, and signing-key discovery. Cover adagents.json as the publisher authorization file that confirms which agents can sell or enrich specific properties. Use fictional examples such as Northwind Media and StreamHaus.'
);

-- Publisher track: B1 and B4 should make seller setup explicit.
SELECT _append_lesson_objective(
  'B1',
  'Publish seller identity and publisher authorization files that buyer agents can verify'
);

SELECT _replace_or_append_key_concept(
  'B1',
  'Seller identity setup',
  'Teach implementers to publish brand.json for the organization operating the selling path and adagents.json for publisher authorization. brand.json answers "who is this seller and which agents/keys/properties do they claim?" adagents.json answers "which agents has this publisher authorized for which properties?" A direct publisher may host both; a delegated seller needs its brand.json claim confirmed by each publisher''s adagents.json.'
);

SELECT _append_lesson_objective(
  'B4',
  'Explain how a buyer can verify the learner''s seller identity and publisher authorization'
);

SELECT _replace_or_append_key_concept(
  'B4',
  'Well-known discovery files',
  'The build project should include or clearly specify the two discovery records a real deployment needs: brand.json for the sales-agent operator''s identity, endpoint declarations, property relationships, and signing-key discovery; adagents.json for publisher properties and authorized agents. For local demos, a learner can describe the files even if their coding assistant only implements the live MCP agent.'
);

SELECT _append_to_key_concept_notes(
  'B4',
  'Phase 4: Explain (~10 min)',
  'Add verification questions: Could a buyer resolve your brand.json and confirm the sales agent and signing key? Could they resolve the publisher adagents.json and confirm the same agent is authorized for the property? If a network or sales rep is involved, does brand.json claim the relationship and adagents.json confirm it?',
  'Could a buyer resolve your brand.json'
);

-- Buyer track: C2 previously centered advertiser identity. Keep that, but teach
-- buyers to inspect seller identity and publisher authorization too.
SELECT _append_lesson_objective(
  'C2',
  'Verify seller brand.json and publisher adagents.json before trusting a supply path'
);

SELECT _replace_or_append_key_concept(
  'C2',
  'Brand identity protocol',
  'Cover brand.json at /.well-known/brand.json as a public identity record. For advertisers it carries brand identity, logos, guidelines, and authorized operators. For sellers, publishers, networks, and platforms it also declares organization identity, agents, property relationships, and signing-key discovery. Do not teach brand.json as buyer-only. Pair it with adagents.json: the operator claims the sales path in brand.json, and the publisher confirms authorization in adagents.json.'
);

SELECT _replace_or_append_key_concept(
  'C2',
  'Property relationships and bilateral verification',
  'Teach bilateral supply-path verification with fictional examples. If Northwind Media sells StreamHaus inventory, Northwind''s brand.json can claim a delegated or network relationship through properties[], but StreamHaus must confirm the authorized sales agent in adagents.json. The relationship value in brand.json should line up with delegation_type in adagents.json. This is the AdCP analogue to sellers.json plus ads.txt, upgraded for agent identity and signing-key discovery.'
);

-- Platform track: D2 was the clearest stale spot. brand.json is identity/key
-- discovery; adagents.json is publisher authorization.
SELECT _append_lesson_objective(
  'D2',
  'Implement verification that checks both seller brand.json and publisher adagents.json'
);

SELECT _replace_or_append_key_concept(
  'D2',
  'Agent identity verification',
  'Teach agent verification as a two-file pattern. brand.json is the operator identity and key-discovery record: who runs this agent, which domain owns the claim, which agents are declared, and where signing keys are published. adagents.json is the publisher authorization record: which agents are authorized for which properties and delegation types. A platform should validate both when a seller agent claims publisher inventory.'
);

SELECT _replace_or_append_key_concept(
  'D2',
  'Supply path transparency',
  'AdCP supply-path transparency means buyers can inspect each operator in the path and verify the relationship. The seller or network declares its sales path and agents in brand.json; the publisher confirms authorization in adagents.json. Use fictional examples such as Northwind Media selling StreamHaus inventory to show why a seller brand.json claim alone is not sufficient.'
);

DROP FUNCTION _append_to_key_concept_notes(text, text, text, text);
DROP FUNCTION _replace_or_append_key_concept(text, text, text);
DROP FUNCTION _append_lesson_objective(text, text);

COMMIT;
