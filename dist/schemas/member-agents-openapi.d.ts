/**
 * OpenAPI registrations for the per-agent REST surface at /api/me/agents.
 *
 * Kept separate from the route file so the spec generator can import this
 * without pulling in middleware/auth.ts (which instantiates WorkOS at module
 * load and refuses to run without env vars).
 */
export {};
//# sourceMappingURL=member-agents-openapi.d.ts.map