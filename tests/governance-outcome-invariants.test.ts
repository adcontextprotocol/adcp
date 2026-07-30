import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();

describe('governance outcome schema invariants', () => {
  it('keeps every reported budget field non-negative', () => {
    const schema = JSON.parse(fs.readFileSync(
      path.join(repoRoot, 'static/schemas/source/governance/report-plan-outcome-request.json'),
      'utf8',
    ));

    expect(schema.properties.delivery.properties.spend).toMatchObject({
      type: 'number',
      minimum: 0,
    });
    expect(schema.properties.seller_response.properties.committed_budget).toMatchObject({
      type: 'number',
      minimum: 0,
    });
    expect(schema.properties.seller_response.properties.packages.items.properties.budget).toMatchObject({
      type: 'number',
      minimum: 0,
    });
  });
});
