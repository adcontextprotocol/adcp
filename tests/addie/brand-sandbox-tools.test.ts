import { describe, it, expect } from '@jest/globals';
import {
  handleGetBrandIdentity,
  handleGetRights,
  handleAcquireRights,
  handleUpdateRights,
} from '../../server/src/training-agent/brand-handlers.js';

const ctx = { mode: 'training' as const };

type Handler = (args: Record<string, unknown>, ctx: { mode: string }) => Record<string, unknown>;

const handlers: Record<string, Handler> = {
  get_brand_identity: handleGetBrandIdentity,
  get_rights: handleGetRights,
  acquire_rights: handleAcquireRights,
  update_rights: handleUpdateRights,
};

function call(tool: string, args: Record<string, unknown>) {
  return handlers[tool](args, ctx);
}

describe('brand protocol tools (training agent)', () => {

  describe('get_brand_identity', () => {

    it('returns core fields for a valid brand', () => {
      const result = call('get_brand_identity', { brand_id: 'daan_janssen' });
      expect(result.brand_id).toBe('daan_janssen');
      expect(result.house).toEqual({ domain: 'lotientertainment.com', name: 'Loti Entertainment' });
      expect(result.names).toEqual([{ en: 'Daan Janssen' }]);
      expect(result.sandbox).toBe(true);
    });

    it('returns public fields without authorization', () => {
      const result = call('get_brand_identity', { brand_id: 'daan_janssen' });
      expect(result.description).toBe('Dutch Olympic speed skater, 2x gold medalist');
      expect(result.industry).toBe('sports');
      expect(result.tagline).toBe('Speed is a choice');
      expect(result.logos).toBeDefined();
    });

    it('withholds authorized fields and lists them in available_fields', () => {
      const result = call('get_brand_identity', { brand_id: 'daan_janssen' });
      expect(result.colors).toBeUndefined();
      expect(result.tone).toBeUndefined();
      expect(result.voice_synthesis).toBeUndefined();
      expect(result.rights).toBeUndefined();
      expect(result.available_fields).toEqual(
        expect.arrayContaining(['colors', 'fonts', 'tone', 'voice_synthesis', 'visual_guidelines', 'rights'])
      );
    });

    it('returns authorized fields with authorized=true', () => {
      const result = call('get_brand_identity', { brand_id: 'daan_janssen', authorized: true });
      expect(result.colors).toBeDefined();
      expect(result.tone).toBeDefined();
      expect(result.voice_synthesis).toBeDefined();
      expect(result.rights).toBeDefined();
      expect(result.available_fields).toBeUndefined();
    });

    it('returns only requested fields', () => {
      const result = call('get_brand_identity', {
        brand_id: 'daan_janssen',
        fields: ['description', 'tagline'],
      });
      expect(result.description).toBeDefined();
      expect(result.tagline).toBeDefined();
      expect(result.industry).toBeUndefined();
      expect(result.logos).toBeUndefined();
    });

    it('returns error for unknown brand', () => {
      const result = call('get_brand_identity', { brand_id: 'nonexistent' });
      expect(result.errors).toBeDefined();
      expect((result.errors as Array<{ code: string }>)[0].code).toBe('brand_not_found');
    });

    it('omits available_fields when talent lacks the requested authorized field', () => {
      const result = call('get_brand_identity', {
        brand_id: 'sofia_reyes',
        fields: ['voice_synthesis'],
      });
      expect(result.voice_synthesis).toBeUndefined();
      expect(result.available_fields).toBeUndefined();
    });
  });

  describe('get_rights', () => {

    it('returns Daan Janssen as top match for Amsterdam steakhouse', () => {
      const result = call('get_rights', {
        query: 'Dutch athlete for restaurant brand in Amsterdam',
        uses: ['likeness'],
      });
      expect((result.rights as Array<{ brand_id: string }>).length).toBeGreaterThan(0);
      expect((result.rights as Array<{ brand_id: string }>)[0].brand_id).toBe('daan_janssen');
    });

    it('excludes van Dijk for steakhouse queries', () => {
      const result = call('get_rights', {
        query: 'Dutch athlete for steakhouse in Amsterdam',
        uses: ['likeness'],
      });
      const brandIds = (result.rights as Array<{ brand_id: string }>).map(r => r.brand_id);
      expect(brandIds).not.toContain('pieter_van_dijk');
    });

    it('shows exclusion reasons with include_excluded=true and includes suggestions', () => {
      const result = call('get_rights', {
        query: 'Dutch athlete for steakhouse in Amsterdam',
        uses: ['likeness'],
        include_excluded: true,
      });
      expect(result.excluded).toBeDefined();
      const excluded = result.excluded as Array<{ brand_id: string; reason: string; suggestions?: string[] }>;
      expect(excluded[0].brand_id).toBe('pieter_van_dijk');
      expect(excluded[0].reason).toContain('lifestyle conflict');
      expect(excluded[0].suggestions).toBeDefined();
      expect(excluded[0].suggestions![0]).toContain('plant-based');
    });

    it('filters by country', () => {
      const result = call('get_rights', {
        query: 'athlete for food brand',
        uses: ['likeness'],
        countries: ['JP'],
      });
      const brandIds = (result.rights as Array<{ brand_id: string }>).map(r => r.brand_id);
      expect(brandIds).toContain('yuki_tanaka');
      expect(brandIds).not.toContain('daan_janssen');
    });

    it('filters by specific brand_id', () => {
      const result = call('get_rights', {
        query: 'athlete',
        uses: ['likeness'],
        brand_id: 'sofia_reyes',
      });
      expect((result.rights as unknown[]).length).toBe(1);
      expect((result.rights as Array<{ brand_id: string }>)[0].brand_id).toBe('sofia_reyes');
    });

    it('includes pricing options', () => {
      const result = call('get_rights', {
        query: 'Dutch athlete for food brand',
        uses: ['likeness'],
      });
      const janssen = (result.rights as Array<{ brand_id: string; pricing_options: Array<{ model: string; price: number; currency: string }> }>)
        .find(r => r.brand_id === 'daan_janssen');
      expect(janssen!.pricing_options.length).toBeGreaterThan(0);
      const cpm = janssen!.pricing_options.find(p => p.model === 'cpm');
      expect(cpm!.price).toBe(3.50);
      expect(cpm!.currency).toBe('EUR');
    });

    it('sorts by match score descending', () => {
      const result = call('get_rights', {
        query: 'Dutch athlete for food brand in Netherlands, budget 400 EUR',
        uses: ['likeness'],
      });
      const scores = (result.rights as Array<{ match_score: number }>).map(r => r.match_score);
      for (let i = 1; i < scores.length; i++) {
        expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
      }
    });
  });

  describe('acquire_rights', () => {
    const baseBuyer = { domain: 'bistro-oranje.nl', brand_id: 'bistro_oranje' };

    it('auto-approves food category for Daan Janssen', () => {
      const result = call('acquire_rights', {
        rights_id: 'janssen_likeness_voice',
        pricing_option_id: 'monthly_exclusive',
        buyer: baseBuyer,
        campaign: {
          description: 'Local restaurant campaign featuring Dutch cuisine',
          uses: ['likeness'],
          countries: ['NL'],
        },
      });
      expect(result.status).toBe('acquired');
      expect((result.generation_credentials as unknown[]).length).toBeGreaterThan(0);
      expect((result.disclosure as { required: boolean }).required).toBe(true);
      expect(result.rights_constraint).toBeDefined();
      expect(result.sandbox).toBe(true);
    });

    it('returns pending_approval for alcohol campaigns', () => {
      const result = call('acquire_rights', {
        rights_id: 'janssen_likeness_voice',
        pricing_option_id: 'cpm_endorsement',
        buyer: { domain: 'brouwerij-test.nl' },
        campaign: {
          description: 'Craft alcohol brand campaign in Amsterdam',
          uses: ['likeness'],
        },
      });
      expect(result.status).toBe('pending_approval');
      expect(result.estimated_response_time).toBe('48h');
    });

    it('rejects sportswear campaigns for Janssen with actionable suggestions', () => {
      const result = call('acquire_rights', {
        rights_id: 'janssen_likeness_voice',
        pricing_option_id: 'cpm_endorsement',
        buyer: { domain: 'sportswear-test.com' },
        campaign: {
          description: 'New sportswear line campaign',
          uses: ['likeness'],
        },
      });
      expect(result.status).toBe('rejected');
      expect(result.reason).toContain('exclusivity');
      expect(result.suggestions).toBeDefined();
      expect((result.suggestions as string[]).length).toBeGreaterThan(0);
    });

    it('rejects confidential rule violations without suggestions', () => {
      const result = call('acquire_rights', {
        rights_id: 'vandijk_likeness',
        pricing_option_id: 'cpm_likeness',
        buyer: baseBuyer,
        campaign: {
          description: 'New meat brand campaign',
          uses: ['likeness'],
        },
      });
      expect(result.status).toBe('rejected');
      expect(result.reason).toBe('This conflicts with our talent lifestyle guidelines');
      expect(result.suggestions).toBeUndefined();
    });

    it('includes voice credentials when voice is requested and talent has voice_synthesis', () => {
      const result = call('acquire_rights', {
        rights_id: 'janssen_likeness_voice',
        pricing_option_id: 'monthly_exclusive',
        buyer: baseBuyer,
        campaign: {
          description: 'Restaurant food campaign',
          uses: ['likeness', 'voice'],
        },
      });
      expect(result.status).toBe('acquired');
      const providers = (result.generation_credentials as Array<{ provider: string }>).map(c => c.provider);
      expect(providers).toContain('midjourney');
      expect(providers).toContain('elevenlabs');
    });

    it('generation credentials match schema (uses, not scope)', () => {
      const result = call('acquire_rights', {
        rights_id: 'janssen_likeness_voice',
        pricing_option_id: 'monthly_exclusive',
        buyer: baseBuyer,
        campaign: {
          description: 'Restaurant food campaign',
          uses: ['likeness'],
        },
      });
      const cred = (result.generation_credentials as Array<Record<string, unknown>>)[0];
      expect(cred.uses).toEqual(['likeness']);
      expect(cred.scope).toBeUndefined();
      expect(cred.credential_type).toBeUndefined();
      expect(cred.rights_key).toMatch(/^rk_mj_sandbox_/);
      expect(cred.expires_at).toMatch(/T\d{2}:\d{2}:\d{2}Z$/);
    });

    it('approval_webhook uses push-notification-config with authentication', () => {
      const result = call('acquire_rights', {
        rights_id: 'janssen_likeness_voice',
        pricing_option_id: 'monthly_exclusive',
        buyer: baseBuyer,
        campaign: {
          description: 'Restaurant food campaign',
          uses: ['likeness'],
        },
      });
      const webhook = result.approval_webhook as { url: string; authentication: { schemes: string[]; credentials: string } };
      expect(webhook).toBeDefined();
      expect(webhook.url).toMatch(/^https:\/\//);
      expect(webhook.authentication).toBeDefined();
      expect(webhook.authentication.schemes).toEqual(['Bearer']);
      expect(webhook.authentication.credentials.length).toBeGreaterThanOrEqual(32);
    });

    it('rights_constraint includes verification_url', () => {
      const result = call('acquire_rights', {
        rights_id: 'janssen_likeness_voice',
        pricing_option_id: 'monthly_exclusive',
        buyer: baseBuyer,
        campaign: {
          description: 'Restaurant food campaign',
          uses: ['likeness'],
        },
      });
      const constraint = result.rights_constraint as { verification_url: string };
      expect(constraint.verification_url).toMatch(/^https:\/\//);
      expect(constraint.verification_url).toContain('/verify');
    });

    it('rights_constraint uses date-time format', () => {
      const result = call('acquire_rights', {
        rights_id: 'janssen_likeness_voice',
        pricing_option_id: 'monthly_exclusive',
        buyer: baseBuyer,
        campaign: {
          description: 'Restaurant food campaign',
          uses: ['likeness'],
          start_date: '2026-04-01',
          end_date: '2026-06-30',
        },
      });
      const constraint = result.rights_constraint as { valid_from: string; valid_until: string };
      expect(constraint.valid_from).toBe('2026-04-01T00:00:00Z');
      expect(constraint.valid_until).toBe('2026-06-30T23:59:59Z');
    });

    it('returns error for unknown rights_id', () => {
      const result = call('acquire_rights', {
        rights_id: 'nonexistent',
        pricing_option_id: 'cpm_endorsement',
        buyer: baseBuyer,
        campaign: { description: 'test', uses: ['likeness'] },
      });
      expect((result.errors as Array<{ code: string }>)[0].code).toBe('rights_not_found');
    });

    it('returns error for invalid pricing option', () => {
      const result = call('acquire_rights', {
        rights_id: 'janssen_likeness_voice',
        pricing_option_id: 'nonexistent',
        buyer: baseBuyer,
        campaign: { description: 'test', uses: ['likeness'] },
      });
      expect((result.errors as Array<{ code: string }>)[0].code).toBe('invalid_pricing_option');
    });

    it('returns error when buyer is missing', () => {
      const result = call('acquire_rights', {
        rights_id: 'janssen_likeness_voice',
        pricing_option_id: 'cpm_endorsement',
        campaign: { description: 'test', uses: ['likeness'] },
      });
      expect((result.errors as Array<{ code: string }>)[0].code).toBe('invalid_request');
    });

    it('rejects cosmetics for Yuki Tanaka', () => {
      const result = call('acquire_rights', {
        rights_id: 'tanaka_likeness_voice',
        pricing_option_id: 'cpm_voice',
        buyer: { domain: 'beauty-test.jp' },
        campaign: {
          description: 'Premium cosmetics brand campaign',
          uses: ['voice'],
        },
      });
      expect(result.status).toBe('rejected');
      expect(result.reason).toContain('cosmetics');
    });
  });

  describe('update_rights', () => {

    it('returns updated terms with extended end_date', () => {
      const result = call('update_rights', {
        rights_id: 'janssen_likeness_voice',
        end_date: '2026-09-30',
      });
      expect(result.rights_id).toBe('janssen_likeness_voice');
      expect((result.terms as { end_date: string }).end_date).toBe('2026-09-30');
    });

    it('returns updated impression cap', () => {
      const result = call('update_rights', {
        rights_id: 'janssen_likeness_voice',
        impression_cap: 200000,
      });
      expect((result.terms as { impression_cap: number }).impression_cap).toBe(200000);
      expect((result.rights_constraint as { impression_cap: number }).impression_cap).toBe(200000);
    });

    it('returns re-issued generation credentials', () => {
      const result = call('update_rights', {
        rights_id: 'janssen_likeness_voice',
        end_date: '2026-09-30',
      });
      const creds = result.generation_credentials as Array<{ expires_at: string; rights_key: string }>;
      expect(creds.length).toBeGreaterThan(0);
      expect(creds[0].expires_at).toBe('2026-09-30T23:59:59Z');
      expect(creds[0].rights_key).toMatch(/^rk_mj_sandbox_/);
    });

    it('returns updated rights_constraint', () => {
      const result = call('update_rights', {
        rights_id: 'janssen_likeness_voice',
        end_date: '2026-09-30',
        impression_cap: 200000,
      });
      const constraint = result.rights_constraint as { valid_until: string; impression_cap: number; rights_id: string };
      expect(constraint.valid_until).toBe('2026-09-30T23:59:59Z');
      expect(constraint.impression_cap).toBe(200000);
      expect(constraint.rights_id).toBe('janssen_likeness_voice');
    });

    it('returns paused state', () => {
      const result = call('update_rights', {
        rights_id: 'janssen_likeness_voice',
        paused: true,
      });
      expect(result.paused).toBe(true);
    });

    it('omits paused when not provided', () => {
      const result = call('update_rights', {
        rights_id: 'janssen_likeness_voice',
      });
      expect(result.paused).toBeUndefined();
    });

    it('returns error for unknown rights_id', () => {
      const result = call('update_rights', {
        rights_id: 'nonexistent',
      });
      expect(result.errors).toBeDefined();
      expect((result.errors as Array<{ code: string }>)[0].code).toBe('rights_not_found');
      expect((result.errors as Array<{ message: string }>)[0].message).toContain('nonexistent');
    });

    it('returns error for impression_cap below delivered', () => {
      const result = call('update_rights', {
        rights_id: 'janssen_likeness_voice',
        impression_cap: 10000,
      });
      expect(result.errors).toBeDefined();
      expect((result.errors as Array<{ code: string }>)[0].code).toBe('invalid_update');
      expect((result.errors as Array<{ message: string }>)[0].message).toContain('10000');
      expect((result.errors as Array<{ message: string }>)[0].message).toContain('50000');
    });

    it('returns error for end_date before current', () => {
      const result = call('update_rights', {
        rights_id: 'janssen_likeness_voice',
        end_date: '2025-01-01',
      });
      expect(result.errors).toBeDefined();
      expect((result.errors as Array<{ code: string }>)[0].code).toBe('invalid_update');
      expect((result.errors as Array<{ message: string }>)[0].message).toContain('end_date');
    });
  });
});
