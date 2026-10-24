/**
 * The documented public activity-history endpoints attribute each revision by
 * display name. Editors with no display name on file were recorded under
 * their email address (`editor_name: displayName || email`), so these routes
 * were publishing contributor addresses to anyone. `publicEditorName`
 * withholds address-shaped values; the existing `system` fallback covers
 * them, the same way it covers automated enrichment.
 */
import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.hoisted(() => {
  process.env.WORKOS_API_KEY ||= 'sk_test_registry_history';
  process.env.WORKOS_CLIENT_ID ||= 'client_test_registry_history';
});

import { createRegistryApiRouter, type RegistryApiConfig } from '../../src/routes/registry-api.js';

function revision(editorName: string | null) {
  return {
    id: 'rev_01',
    revision_number: 3,
    editor_user_id: 'user_01EDITOR',
    editor_email: 'editor@example.com',
    editor_name: editorName,
    edit_summary: 'Updated the record',
    snapshot: { source_type: 'community' },
    is_rollback: false,
    created_at: new Date('2026-03-01T00:00:00.000Z'),
  };
}

function app(editorName: string | null) {
  const app = express();
  app.use(express.json());
  const noop: import('express').RequestHandler = (_req, _res, next) => next();
  app.use('/api', createRegistryApiRouter({
    brandManager: {} as RegistryApiConfig['brandManager'],
    brandDb: {
      getBrandRevisions: async () => [revision(editorName)],
      getBrandRevisionCount: async () => 1,
    } as unknown as RegistryApiConfig['brandDb'],
    propertyDb: {
      getPropertyRevisions: async () => [revision(editorName)],
      getPropertyRevisionCount: async () => 1,
    } as unknown as RegistryApiConfig['propertyDb'],
    adagentsManager: {} as RegistryApiConfig['adagentsManager'],
    healthChecker: {} as RegistryApiConfig['healthChecker'],
    crawler: {} as RegistryApiConfig['crawler'],
    capabilityDiscovery: {} as RegistryApiConfig['capabilityDiscovery'],
    registryRequestsDb: { trackRequest: async () => {}, markResolved: async () => true },
    requireAuth: noop,
    optionalAuth: noop,
  }));
  return app;
}

describe.each([
  { label: 'brands', path: '/api/brands/history?domain=acme.example' },
  { label: 'properties', path: '/api/properties/history?domain=news.example' },
])('GET /api/$label/history', ({ path }) => {
  it('publishes a display name', async () => {
    const res = await request(app('Sam Adeyemi')).get(path);
    expect(res.status).toBe(200);
    expect(res.body.revisions[0].editor_name).toBe('Sam Adeyemi');
  });

  it('falls back to system rather than publishing an email address', async () => {
    const res = await request(app('editor@example.com')).get(path);
    expect(res.status).toBe(200);
    expect(res.body.revisions[0].editor_name).toBe('system');
    expect(JSON.stringify(res.body)).not.toContain('editor@example.com');
  });

  it('never carries the revision row contact fields', async () => {
    const res = await request(app(null)).get(path);
    expect(res.status).toBe(200);
    expect(res.body.revisions[0]).not.toHaveProperty('editor_email');
    expect(res.body.revisions[0]).not.toHaveProperty('editor_user_id');
    expect(res.body.revisions[0]).not.toHaveProperty('snapshot');
  });
});
