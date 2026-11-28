/**
 * The version of the engine's behaviour. Bump it whenever a change makes the
 * same season and the same calls produce a different result (forecasts,
 * delivery, availability). Results record it beside the season, so only
 * results from the same engine and season are compared, and a stored market
 * from another version restarts.
 */
export const ENGINE_VERSION = '2';
