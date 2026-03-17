-- Add Certifier group IDs for Signals and Sponsored Intelligence credentials
UPDATE certification_credentials
SET certifier_group_id = '01kkyfhpvtbax8ptyf3vy67mmv'
WHERE id = 'specialist_signals';

UPDATE certification_credentials
SET certifier_group_id = '01kkyfx59c9zftbe3p200685sz'
WHERE id = 'specialist_si';
