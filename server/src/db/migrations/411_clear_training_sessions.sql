-- One-time clear of training-agent sessions: the serialization format
-- changed when we adopted @adcp/client 5.1's structuredSerialize helpers
-- (tagged envelopes for Map/Date instead of hand-rolled Object.fromEntries).
--
-- Training sessions are sandbox state with a 1-hour TTL — losing them is
-- equivalent to a ~1-hour-stale machine restart. Other collections in
-- adcp_state (if any — today this table is training-sessions only) are
-- preserved.

DELETE FROM adcp_state WHERE collection = 'training_sessions';
