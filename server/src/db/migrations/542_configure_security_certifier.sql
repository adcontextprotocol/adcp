-- Configure the S6 Security credential for Certifier issuance.
--
-- The credential template was created in Certifier on 2026-08-11 using the
-- same certificate and badge designs as every other AdCP credential. Stefan's
-- already-earned credential was issued directly while production still had a
-- NULL group mapping; persist that provider state here so the normal recovery
-- service will treat it as complete instead of creating a duplicate.

UPDATE certification_credentials
SET certifier_group_id = '01kzr2vm58fzxppy55wpvrw8tf'
WHERE id = 'specialist_security';

DO $$
DECLARE
  existing_credential_id text;
BEGIN
  SELECT certifier_credential_id
  INTO existing_credential_id
  FROM user_credentials
  WHERE workos_user_id = 'user_01KFFQYQ46GY1G21N42NW4VPKD'
    AND credential_id = 'specialist_security';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expected earned specialist_security credential is missing';
  END IF;

  IF existing_credential_id IS NOT NULL
     AND existing_credential_id <> '01kzr2zagss4s4j1fw8q0c7zpz' THEN
    RAISE EXCEPTION
      'specialist_security already points at unexpected Certifier credential %',
      existing_credential_id;
  END IF;

  UPDATE user_credentials
  SET certifier_credential_id = '01kzr2zagss4s4j1fw8q0c7zpz',
      certifier_public_id = '7f313510-1a17-4ab4-953e-dd9f6b33b207',
      certifier_badge_url = 'https://cdn.certifier.io/63257337-1360-49a9-a2f4-066b9dafab4e/credentials/01kzr2zagss4s4j1fw8q0c7zpz/designs/01kk468tvprzwk78772sc4zj2q/wVVFjlz979.png',
      certifier_issuance_state = 'complete',
      certifier_delivery_state = 'sent',
      certifier_issued_at = '2026-08-11T09:38:03.725Z'
  WHERE workos_user_id = 'user_01KFFQYQ46GY1G21N42NW4VPKD'
    AND credential_id = 'specialist_security';
END $$;
