import { createBrandSandboxToolHandlers, BRAND_SANDBOX_TOOLS } from '../../server/src/addie/mcp/brand-sandbox-tools.js';

const handlers = createBrandSandboxToolHandlers();

describe('brand sandbox tools', () => {

  describe('tool definitions', () => {
    it('exports four tools', () => {
      expect(BRAND_SANDBOX_TOOLS).toHaveLength(4);
      const names = BRAND_SANDBOX_TOOLS.map(t => t.name);
      expect(names).toEqual([
        'sandbox_get_brand_identity',
        'sandbox_get_rights',
        'sandbox_acquire_rights',
        'sandbox_update_rights',
      ]);
    });

    it('registers four handlers', () => {
      expect(handlers.size).toBe(4);
    });
  });

  describe('sandbox_get_brand_identity', () => {
    const handler = handlers.get('sandbox_get_brand_identity')!;

    it('returns core fields for a valid brand', async () => {
      const result = JSON.parse(await handler({ brand_id: 'daan_janssen' }));
      expect(result.brand_id).toBe('daan_janssen');
      expect(result.house).toEqual({ domain: 'lotientertainment.com', name: 'Loti Entertainment' });
      expect(result.names).toEqual([{ en: 'Daan Janssen' }]);
    });

    it('returns public fields without authorization', async () => {
      const result = JSON.parse(await handler({ brand_id: 'daan_janssen' }));
      expect(result.description).toBe('Dutch Olympic speed skater, 2x gold medalist');
      expect(result.industry).toBe('sports');
      expect(result.tagline).toBe('Speed is a choice');
      expect(result.logos).toBeDefined();
    });

    it('withholds authorized fields and lists them in available_fields', async () => {
      const result = JSON.parse(await handler({ brand_id: 'daan_janssen' }));
      expect(result.colors).toBeUndefined();
      expect(result.tone).toBeUndefined();
      expect(result.voice_synthesis).toBeUndefined();
      expect(result.rights).toBeUndefined();
      expect(result.available_fields).toEqual(
        expect.arrayContaining(['colors', 'fonts', 'tone', 'voice_synthesis', 'visual_guidelines', 'rights'])
      );
    });

    it('returns authorized fields with authorized=true', async () => {
      const result = JSON.parse(await handler({ brand_id: 'daan_janssen', authorized: true }));
      expect(result.colors).toBeDefined();
      expect(result.tone).toBeDefined();
      expect(result.voice_synthesis).toBeDefined();
      expect(result.rights).toBeDefined();
      expect(result.available_fields).toBeUndefined();
    });

    it('returns only requested fields', async () => {
      const result = JSON.parse(await handler({
        brand_id: 'daan_janssen',
        fields: ['description', 'tagline'],
      }));
      expect(result.description).toBeDefined();
      expect(result.tagline).toBeDefined();
      expect(result.industry).toBeUndefined();
      expect(result.logos).toBeUndefined();
    });

    it('returns error for unknown brand', async () => {
      const result = JSON.parse(await handler({ brand_id: 'nonexistent' }));
      expect(result.errors).toBeDefined();
      expect(result.errors[0].code).toBe('brand_not_found');
    });

    it('omits available_fields when talent lacks the requested authorized field', async () => {
      const result = JSON.parse(await handler({
        brand_id: 'sofia_reyes',
        fields: ['voice_synthesis'],
      }));
      expect(result.voice_synthesis).toBeUndefined();
      expect(result.available_fields).toBeUndefined();
    });
  });

  describe('sandbox_get_rights', () => {
    const handler = handlers.get('sandbox_get_rights')!;

    it('returns Daan Janssen as top match for Amsterdam steakhouse', async () => {
      const result = JSON.parse(await handler({
        query: 'Dutch athlete for restaurant brand in Amsterdam',
        uses: ['likeness'],
      }));
      expect(result.rights.length).toBeGreaterThan(0);
      expect(result.rights[0].brand_id).toBe('daan_janssen');
    });

    it('excludes van Dijk for steakhouse queries', async () => {
      const result = JSON.parse(await handler({
        query: 'Dutch athlete for steakhouse in Amsterdam',
        uses: ['likeness'],
      }));
      const brandIds = result.rights.map((r: { brand_id: string }) => r.brand_id);
      expect(brandIds).not.toContain('pieter_van_dijk');
    });

    it('shows exclusion reasons with include_excluded=true and includes suggestions', async () => {
      const result = JSON.parse(await handler({
        query: 'Dutch athlete for steakhouse in Amsterdam',
        uses: ['likeness'],
        include_excluded: true,
      }));
      expect(result.excluded).toBeDefined();
      expect(result.excluded[0].brand_id).toBe('pieter_van_dijk');
      expect(result.excluded[0].reason).toContain('lifestyle conflict');
      expect(result.excluded[0].suggestions).toBeDefined();
      expect(result.excluded[0].suggestions[0]).toContain('plant-based');
    });

    it('filters by country', async () => {
      const result = JSON.parse(await handler({
        query: 'athlete for food brand',
        uses: ['likeness'],
        countries: ['JP'],
      }));
      const brandIds = result.rights.map((r: { brand_id: string }) => r.brand_id);
      expect(brandIds).toContain('yuki_tanaka');
      expect(brandIds).not.toContain('daan_janssen');
    });

    it('filters by specific brand_id', async () => {
      const result = JSON.parse(await handler({
        query: 'athlete',
        uses: ['likeness'],
        brand_id: 'sofia_reyes',
      }));
      expect(result.rights).toHaveLength(1);
      expect(result.rights[0].brand_id).toBe('sofia_reyes');
    });

    it('includes pricing options', async () => {
      const result = JSON.parse(await handler({
        query: 'Dutch athlete for food brand',
        uses: ['likeness'],
      }));
      const janssen = result.rights.find((r: { brand_id: string }) => r.brand_id === 'daan_janssen');
      expect(janssen.pricing_options.length).toBeGreaterThan(0);
      const cpm = janssen.pricing_options.find((p: { model: string }) => p.model === 'cpm');
      expect(cpm.price).toBe(3.50);
      expect(cpm.currency).toBe('EUR');
    });

    it('sorts by match score descending', async () => {
      const result = JSON.parse(await handler({
        query: 'Dutch athlete for food brand in Netherlands, budget 400 EUR',
        uses: ['likeness'],
      }));
      const scores = result.rights.map((r: { match_score: number }) => r.match_score);
      for (let i = 1; i < scores.length; i++) {
        expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
      }
    });
  });

  describe('sandbox_acquire_rights', () => {
    const handler = handlers.get('sandbox_acquire_rights')!;
    const baseBuyer = { domain: 'bistro-oranje.nl', brand_id: 'bistro_oranje' };

    it('auto-approves food category for Daan Janssen', async () => {
      const result = JSON.parse(await handler({
        rights_id: 'janssen_likeness_voice',
        pricing_option_id: 'monthly_exclusive',
        buyer: baseBuyer,
        campaign: {
          description: 'Local restaurant campaign featuring Dutch cuisine',
          uses: ['likeness'],
          countries: ['NL'],
        },
      }));
      expect(result.status).toBe('acquired');
      expect(result.generation_credentials.length).toBeGreaterThan(0);
      expect(result.disclosure.required).toBe(true);
      expect(result.rights_constraint).toBeDefined();
    });

    it('returns pending_approval for alcohol campaigns', async () => {
      const result = JSON.parse(await handler({
        rights_id: 'janssen_likeness_voice',
        pricing_option_id: 'cpm_endorsement',
        buyer: { domain: 'brouwerij-test.nl' },
        campaign: {
          description: 'Craft alcohol brand campaign in Amsterdam',
          uses: ['likeness'],
        },
      }));
      expect(result.status).toBe('pending_approval');
      expect(result.estimated_response_time).toBe('48h');
    });

    it('rejects sportswear campaigns for Janssen with actionable suggestions', async () => {
      const result = JSON.parse(await handler({
        rights_id: 'janssen_likeness_voice',
        pricing_option_id: 'cpm_endorsement',
        buyer: { domain: 'sportswear-test.com' },
        campaign: {
          description: 'New sportswear line campaign',
          uses: ['likeness'],
        },
      }));
      expect(result.status).toBe('rejected');
      expect(result.reason).toContain('exclusivity');
      expect(result.suggestions).toBeDefined();
      expect(result.suggestions.length).toBeGreaterThan(0);
    });

    it('rejects confidential rule violations without suggestions', async () => {
      const result = JSON.parse(await handler({
        rights_id: 'vandijk_likeness',
        pricing_option_id: 'cpm_likeness',
        buyer: baseBuyer,
        campaign: {
          description: 'New meat brand campaign',
          uses: ['likeness'],
        },
      }));
      expect(result.status).toBe('rejected');
      expect(result.reason).toBe('This conflicts with our talent lifestyle guidelines');
      expect(result.suggestions).toBeUndefined();
    });

    it('includes voice credentials when voice is requested and talent has voice_synthesis', async () => {
      const result = JSON.parse(await handler({
        rights_id: 'janssen_likeness_voice',
        pricing_option_id: 'monthly_exclusive',
        buyer: baseBuyer,
        campaign: {
          description: 'Restaurant food campaign',
          uses: ['likeness', 'voice'],
        },
      }));
      expect(result.status).toBe('acquired');
      const providers = result.generation_credentials.map((c: { provider: string }) => c.provider);
      expect(providers).toContain('midjourney');
      expect(providers).toContain('elevenlabs');
    });

    it('generation credentials match schema (uses, not scope)', async () => {
      const result = JSON.parse(await handler({
        rights_id: 'janssen_likeness_voice',
        pricing_option_id: 'monthly_exclusive',
        buyer: baseBuyer,
        campaign: {
          description: 'Restaurant food campaign',
          uses: ['likeness'],
        },
      }));
      const cred = result.generation_credentials[0];
      expect(cred.uses).toEqual(['likeness']);
      expect(cred.scope).toBeUndefined();
      expect(cred.credential_type).toBeUndefined();
      expect(cred.rights_key).toMatch(/^rk_mj_sandbox_/);
      expect(cred.expires_at).toMatch(/T\d{2}:\d{2}:\d{2}Z$/);
    });

    it('approval_webhook uses push-notification-config with authentication', async () => {
      const result = JSON.parse(await handler({
        rights_id: 'janssen_likeness_voice',
        pricing_option_id: 'monthly_exclusive',
        buyer: baseBuyer,
        campaign: {
          description: 'Restaurant food campaign',
          uses: ['likeness'],
        },
      }));
      expect(result.approval_webhook).toBeDefined();
      expect(result.approval_webhook.url).toMatch(/^https:\/\//);
      expect(result.approval_webhook.authentication).toBeDefined();
      expect(result.approval_webhook.authentication.schemes).toEqual(['Bearer']);
      expect(result.approval_webhook.authentication.credentials.length).toBeGreaterThanOrEqual(32);
    });

    it('rights_constraint includes verification_url', async () => {
      const result = JSON.parse(await handler({
        rights_id: 'janssen_likeness_voice',
        pricing_option_id: 'monthly_exclusive',
        buyer: baseBuyer,
        campaign: {
          description: 'Restaurant food campaign',
          uses: ['likeness'],
        },
      }));
      expect(result.rights_constraint.verification_url).toMatch(/^https:\/\//);
      expect(result.rights_constraint.verification_url).toContain('/verify');
    });

    it('rights_constraint uses date-time format', async () => {
      const result = JSON.parse(await handler({
        rights_id: 'janssen_likeness_voice',
        pricing_option_id: 'monthly_exclusive',
        buyer: baseBuyer,
        campaign: {
          description: 'Restaurant food campaign',
          uses: ['likeness'],
          start_date: '2026-04-01',
          end_date: '2026-06-30',
        },
      }));
      expect(result.rights_constraint.valid_from).toBe('2026-04-01T00:00:00Z');
      expect(result.rights_constraint.valid_until).toBe('2026-06-30T23:59:59Z');
    });

    it('returns error for unknown rights_id', async () => {
      const result = JSON.parse(await handler({
        rights_id: 'nonexistent',
        pricing_option_id: 'cpm_endorsement',
        buyer: baseBuyer,
        campaign: { description: 'test', uses: ['likeness'] },
      }));
      expect(result.errors[0].code).toBe('rights_not_found');
    });

    it('returns error for invalid pricing option', async () => {
      const result = JSON.parse(await handler({
        rights_id: 'janssen_likeness_voice',
        pricing_option_id: 'nonexistent',
        buyer: baseBuyer,
        campaign: { description: 'test', uses: ['likeness'] },
      }));
      expect(result.errors[0].code).toBe('invalid_pricing_option');
    });

    it('returns error when buyer is missing', async () => {
      const result = JSON.parse(await handler({
        rights_id: 'janssen_likeness_voice',
        pricing_option_id: 'cpm_endorsement',
        campaign: { description: 'test', uses: ['likeness'] },
      }));
      expect(result.errors[0].code).toBe('invalid_request');
    });

    it('rejects cosmetics for Yuki Tanaka', async () => {
      const result = JSON.parse(await handler({
        rights_id: 'tanaka_likeness_voice',
        pricing_option_id: 'cpm_voice',
        buyer: { domain: 'beauty-test.jp' },
        campaign: {
          description: 'Premium cosmetics brand campaign',
          uses: ['voice'],
        },
      }));
      expect(result.status).toBe('rejected');
      expect(result.reason).toContain('cosmetics');
    });
  });

  describe('sandbox_update_rights', () => {
    const handler = handlers.get('sandbox_update_rights')!;

    it('returns updated terms with extended end_date', async () => {
      const result = JSON.parse(await handler({
        rights_id: 'janssen_likeness_voice',
        end_date: '2026-09-30',
      }));
      expect(result.rights_id).toBe('janssen_likeness_voice');
      expect(result.terms.end_date).toBe('2026-09-30');
    });

    it('returns updated impression cap', async () => {
      const result = JSON.parse(await handler({
        rights_id: 'janssen_likeness_voice',
        impression_cap: 200000,
      }));
      expect(result.terms.impression_cap).toBe(200000);
      expect(result.rights_constraint.impression_cap).toBe(200000);
    });

    it('returns re-issued generation credentials', async () => {
      const result = JSON.parse(await handler({
        rights_id: 'janssen_likeness_voice',
        end_date: '2026-09-30',
      }));
      expect(result.generation_credentials.length).toBeGreaterThan(0);
      const cred = result.generation_credentials[0];
      expect(cred.expires_at).toBe('2026-09-30T23:59:59Z');
      expect(cred.rights_key).toMatch(/^rk_mj_sandbox_/);
    });

    it('returns updated rights_constraint', async () => {
      const result = JSON.parse(await handler({
        rights_id: 'janssen_likeness_voice',
        end_date: '2026-09-30',
        impression_cap: 200000,
      }));
      expect(result.rights_constraint.valid_until).toBe('2026-09-30T23:59:59Z');
      expect(result.rights_constraint.impression_cap).toBe(200000);
      expect(result.rights_constraint.rights_id).toBe('janssen_likeness_voice');
    });

    it('returns paused state', async () => {
      const result = JSON.parse(await handler({
        rights_id: 'janssen_likeness_voice',
        paused: true,
      }));
      expect(result.paused).toBe(true);
    });

    it('omits paused when not provided', async () => {
      const result = JSON.parse(await handler({
        rights_id: 'janssen_likeness_voice',
      }));
      expect(result.paused).toBeUndefined();
    });

    it('returns error for unknown rights_id', async () => {
      const result = JSON.parse(await handler({
        rights_id: 'nonexistent',
      }));
      expect(result.errors).toBeDefined();
      expect(result.errors[0].code).toBe('rights_not_found');
      expect(result.errors[0].message).toContain('nonexistent');
    });

    it('returns error for impression_cap below delivered', async () => {
      const result = JSON.parse(await handler({
        rights_id: 'janssen_likeness_voice',
        impression_cap: 10000,
      }));
      expect(result.errors).toBeDefined();
      expect(result.errors[0].code).toBe('invalid_update');
      expect(result.errors[0].message).toContain('10000');
      expect(result.errors[0].message).toContain('50000');
    });

    it('returns error for end_date before current', async () => {
      const result = JSON.parse(await handler({
        rights_id: 'janssen_likeness_voice',
        end_date: '2025-01-01',
      }));
      expect(result.errors).toBeDefined();
      expect(result.errors[0].code).toBe('invalid_update');
      expect(result.errors[0].message).toContain('end_date');
    });
  });
});
