-- Migration 237: Update outreach goal names to use original persona names
UPDATE outreach_goals SET
  name = 'Invite Molecular Gastronomist to Creative',
  description = 'Invite Molecular Gastronomist personas to the Creative council where art meets science'
WHERE requires_persona = '{molecule_builder}' AND name = 'Invite Molecule Builder to Creative';

UPDATE outreach_goals SET
  name = 'Invite Data Denizen to Signals & Data',
  description = 'Invite Data Denizen personas to the Signals & Data working group'
WHERE requires_persona = '{data_decoder}' AND name = 'Invite Data Decoder to Signals & Data';

UPDATE outreach_goals SET
  name = 'Invite Mold Breaker to Brand Standards',
  description = 'Invite Mold Breaker personas to Brand Standards WG focused on clean advertising'
WHERE requires_persona = '{pureblood_protector}' AND name = 'Invite Pureblood Protector to Brand Standards';

UPDATE outreach_goals SET
  name = 'Invite RevOps Integrator to Media Buying Protocol',
  description = 'Invite RevOps Integrator personas to the Media Buying Protocol WG'
WHERE requires_persona = '{resops_integrator}' AND name = 'Invite ResOps Integrator to Media Buying Protocol';

UPDATE outreach_goals SET
  name = 'Invite Positionless Marketer to Training & Events',
  description = 'Invite Positionless Marketer personas to Training/Education WG and Events'
WHERE requires_persona = '{ladder_climber}' AND name = 'Invite Ladder Climber to Training & Events';

UPDATE outreach_goals SET
  name = 'Guide Simple Simon to Resources',
  description = 'Help Simple Simon personas discover educational resources'
WHERE requires_persona = '{simple_starter}' AND name = 'Guide Simple Starter to Resources';
