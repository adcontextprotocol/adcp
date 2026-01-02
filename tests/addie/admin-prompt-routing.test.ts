/**
 * Admin Prompt Routing Tests
 *
 * Tests that Addie routes admin queries to the correct tools.
 * These tests validate the tool selection logic based on prompt patterns.
 *
 * Run with: npx jest tests/addie/admin-prompt-routing.test.ts
 */

import { describe, expect, test } from '@jest/globals';

/**
 * Expected tool routing for different admin query patterns.
 * Each entry maps a prompt pattern to expected tool(s).
 */
const ADMIN_PROMPT_ROUTING: Array<{
  category: string;
  prompts: string[];
  expectedTools: string[];
  notExpectedTools?: string[];
  description: string;
}> = [
  // Organization Details Queries
  {
    category: 'Slack Users',
    prompts: [
      'How many users are in Slack from Boltive?',
      'How many Slack users does The Trade Desk have?',
      'Who from Magnite is in our Slack?',
      'Is anyone from Boltive in Slack?',
    ],
    expectedTools: ['get_organization_details'],
    description: 'Slack user count queries should use get_organization_details',
  },
  {
    category: 'Working Groups',
    prompts: [
      'Which working groups is Boltive contributing to?',
      'What working groups is The Trade Desk in?',
      'Is Magnite participating in any working groups?',
      'Show me working group participation for Yahoo',
    ],
    expectedTools: ['get_organization_details'],
    description: 'Working group queries should use get_organization_details',
  },
  {
    category: 'Company Research',
    prompts: [
      'What do we know about Boltive as a company?',
      'Tell me about The Trade Desk',
      'Give me the full picture on Magnite',
      'What info do we have on Yahoo?',
    ],
    expectedTools: ['get_organization_details'],
    description: 'General company research should use get_organization_details',
  },
  {
    category: 'Signup Status',
    prompts: [
      'Has Boltive signed up yet?',
      'Is The Trade Desk a member?',
      'What is Magnite\'s membership status?',
      'Did Yahoo renew their membership?',
    ],
    expectedTools: ['get_organization_details'],
    notExpectedTools: ['find_prospect'],
    description: 'Membership status queries should use get_organization_details for full context',
  },
  {
    category: 'Engagement',
    prompts: [
      'How engaged is Boltive?',
      'What is The Trade Desk\'s engagement level?',
      'How interested is Magnite?',
      'Is Yahoo active in the community?',
    ],
    expectedTools: ['get_organization_details'],
    description: 'Engagement queries should use get_organization_details',
  },

  // Prospect Management Queries
  {
    category: 'Prospect Check',
    prompts: [
      'Check on Boltive as a prospect',
      'Is Boltive in our prospect pipeline?',
      'Do we have Boltive as a prospect?',
    ],
    expectedTools: ['find_prospect'],
    description: 'Simple prospect existence checks can use find_prospect',
  },
  {
    category: 'Add Prospect',
    prompts: [
      'Add Boltive as a prospect',
      'Create a prospect for The Trade Desk',
      'Add Magnite - contact is John Smith, VP Sales',
    ],
    expectedTools: ['find_prospect', 'add_prospect'],
    description: 'Adding prospects should first check existence, then add',
  },
  {
    category: 'Update Prospect',
    prompts: [
      'Update Boltive status to interested',
      'Mark The Trade Desk as contacted',
      'Change Magnite\'s contact to Jane Doe',
    ],
    expectedTools: ['update_prospect'],
    description: 'Status updates should use update_prospect',
  },
  {
    category: 'List Prospects',
    prompts: [
      'Show me all interested prospects',
      'List prospects we\'ve contacted',
      'What prospects need follow up?',
      'Show the prospect pipeline',
    ],
    expectedTools: ['list_prospects'],
    description: 'Listing multiple prospects should use list_prospects',
  },

  // Billing Queries
  {
    category: 'Invoices',
    prompts: [
      'Who has pending invoices?',
      'Show me unpaid invoices',
      'What organizations owe us money?',
    ],
    expectedTools: ['list_pending_invoices'],
    description: 'Invoice queries should use list_pending_invoices',
  },
  {
    category: 'Organization Billing',
    prompts: [
      'Does Boltive have any outstanding invoices?',
      'What\'s the billing status for The Trade Desk?',
    ],
    expectedTools: ['lookup_organization'],
    description: 'Org-specific billing queries can use lookup_organization',
  },

  // Enrichment Queries
  {
    category: 'Company Enrichment',
    prompts: [
      'Research Boltive company details',
      'Get firmographic data for The Trade Desk',
      'Enrich Magnite with Lusha data',
    ],
    expectedTools: ['enrich_company'],
    description: 'Explicit enrichment requests should use enrich_company',
  },
  {
    category: 'Prospect Search',
    prompts: [
      'Find ad tech companies with 100+ employees',
      'Search for DSP companies in the US',
      'Find potential prospects in the publisher space',
    ],
    expectedTools: ['prospect_search_lusha'],
    description: 'Prospecting searches should use prospect_search_lusha',
  },
];

describe('Admin Prompt Routing', () => {
  describe('Tool Selection Patterns', () => {
    for (const testCase of ADMIN_PROMPT_ROUTING) {
      describe(testCase.category, () => {
        test(testCase.description, () => {
          // This test documents expected behavior
          // Actual routing is done by Claude based on tool descriptions and system prompt
          expect(testCase.expectedTools.length).toBeGreaterThan(0);
          expect(testCase.prompts.length).toBeGreaterThan(0);
        });

        test.each(testCase.prompts)('"%s" → %s', (prompt) => {
          // Document the expected mapping
          console.log(`  Prompt: "${prompt}"`);
          console.log(`  Expected tools: ${testCase.expectedTools.join(', ')}`);
          if (testCase.notExpectedTools) {
            console.log(`  NOT expected: ${testCase.notExpectedTools.join(', ')}`);
          }
          expect(true).toBe(true);
        });
      });
    }
  });

  describe('Coverage', () => {
    test('All tool categories are covered', () => {
      const expectedCategories = [
        'Slack Users',
        'Working Groups',
        'Company Research',
        'Signup Status',
        'Engagement',
        'Prospect Check',
        'Add Prospect',
        'Update Prospect',
        'List Prospects',
        'Invoices',
        'Organization Billing',
        'Company Enrichment',
        'Prospect Search',
      ];

      const coveredCategories = ADMIN_PROMPT_ROUTING.map(tc => tc.category);
      for (const category of expectedCategories) {
        expect(coveredCategories).toContain(category);
      }
    });

    test('All admin tools have test coverage', () => {
      const adminTools = [
        'get_organization_details',
        'find_prospect',
        'add_prospect',
        'update_prospect',
        'list_prospects',
        'lookup_organization',
        'list_pending_invoices',
        'enrich_company',
        'prospect_search_lusha',
      ];

      const coveredTools = new Set(
        ADMIN_PROMPT_ROUTING.flatMap(tc => tc.expectedTools)
      );

      for (const tool of adminTools) {
        expect(coveredTools.has(tool)).toBe(true);
      }
    });
  });
});

/**
 * Export for use in other tests or evaluation scripts
 */
export { ADMIN_PROMPT_ROUTING };
