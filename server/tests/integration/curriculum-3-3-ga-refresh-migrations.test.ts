/**
 * Integration test for migrations 639-642: the 3.3 GA curriculum refresh
 * (A1 learner-first opening, S1 sandbox guidance, the 3.3 GA refresh, and the
 * storefront/inventory roles).
 *
 * Runs the shipped SQL files in order against minimal module rows in a
 * throwaway schema. Each row carries exactly the topics, criterion IDs,
 * sandbox actions and passages the migrations anchor on, so the assertions
 * cover the shipped SQL rather than a paraphrase of it. The full migration
 * chain is covered by the migration smoke test workflow.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';

const MIGRATION_FILES = [
  '639_curriculum_a1_learner_first_opening.sql',
  '640_curriculum_s1_sandbox_guidance.sql',
  '641_curriculum_3_3_ga_refresh.sql',
  '642_curriculum_storefront_inventory_roles.sql',
] as const;
const [MIG_639, MIG_640, MIG_641, MIG_642] = MIGRATION_FILES.map(file =>
  readFileSync(resolve(__dirname, '../../src/db/migrations', file), 'utf8'),
);

const MIGRATION_HELPERS = [
  '_s1_append_action_guidance(text,text,text,text)',
  '_s1_insert_action_after(text,text,text,text,text)',
  '_s1_replace_criterion_text(text,text,text,text)',
  '_c33_replace_criterion_passage(text,text,text,text,text)',
  '_c33_replace_criterion_text(text,text,text,text)',
  '_c33_replace_concept_passage(text,text,text,text)',
  '_c33_set_key_concept(text,text,text,text)',
  '_c33_append_key_concept(text,text,text)',
  '_c33_replace_sandbox_action(text,text,text,text,text)',
];

const S7_OLD_PASSAGE = 'The operator axis surfaces at runtime in the Accounts Protocol: every action carries an account whose natural key is {brand, operator} (operator = the domain of the entity operating the account; equals the brand\'s own domain when the brand operates directly). The seller\'s require_operator_auth capability selects the reference shape — true = seller-assigned account_id namespaces with independent operator auth (use list_accounts); false = buyer-declared {brand, operator} pairs provisioned via sync_accounts.';
const S7_OLD_CRITERION_PASSAGE = 'and reasons about how the seller\'s require_operator_auth selects the {brand, operator} natural-key vs seller-assigned account_id reference shape.';
const A2B_TOPIC = 'Async polling with tasks/get';
const A2B_EXPLANATION = 'Seeded A2B explanation';

interface Criterion { id: string; text: string }
interface Action { tool: string; guidance: string }
interface Exercise {
  id: string;
  title: string;
  description?: string;
  sandbox_actions: Action[];
  success_criteria: Criterion[];
}
interface Concept { topic: string; teaching_notes?: string; explanation?: string }
interface LessonPlan {
  objectives: string[];
  key_concepts: Concept[];
  discussion_prompts?: string[];
  demo_scenarios?: Array<{ tools: string[]; description: string; expected_outcome: string }>;
}
interface ModuleRow {
  id: string;
  lesson_plan: LessonPlan;
  exercise_definitions: Exercise[];
}

const criterion = (id: string, text = `Seeded ${id}`): Criterion => ({ id, text });
const concept = (topic: string, teaching_notes = `Seeded notes for ${topic}`): Concept => ({ topic, teaching_notes });
const exercise = (id: string, criteria: Criterion[], actions: Action[] = [], title = `Exercise ${id}`): Exercise => ({
  id, title, description: `Seeded ${id}`, sandbox_actions: actions, success_criteria: criteria,
});
const plan = (key_concepts: Concept[], extra: Partial<LessonPlan> = {}): LessonPlan => ({
  objectives: ['Seeded objective'], key_concepts, discussion_prompts: [], ...extra,
});

/** Modules holding exactly the anchors 639-642 look for, copied from the values they replace. */
function seedModules(): ModuleRow[] {
  return [
    { id: 'A1', exercise_definitions: [], lesson_plan: plan([
      concept('Agentic vs traditional programmatic', 'Start with a demonstration: call get_products.'),
      concept('The protocol hierarchy', 'AdCP is built on MCP.'),
      concept('A1 untouched concept'),
    ]) },
    { id: 'A2', lesson_plan: plan([concept('Reading capabilities')]), exercise_definitions: [
      exercise('a2_ex1', [criterion('a2_ex1_sc_version_negotiation')]),
    ] },
    { id: 'A2B', exercise_definitions: [], lesson_plan: plan([
      { topic: A2B_TOPIC, explanation: A2B_EXPLANATION, teaching_notes: 'Poll tasks/get every few seconds; it builds the muscle memory.' },
    ]) },
    { id: 'A3', exercise_definitions: [], lesson_plan: plan([
      concept('Accounts and billing', 'Accounts. sync_accounts establishes billing relationships, list_accounts manages them. More.'),
      concept('Media buy beyond the basics'),
      concept('Sell-side identity and authorization', 'Seeded identity notes.'),
    ]) },
    { id: 'B1', lesson_plan: plan([
      concept('Product catalog design', 'Design products. The catalog is your storefront. Keep it fresh.'),
      concept('B1 untouched concept'),
    ], { discussion_prompts: ['Seeded prompt'] }), exercise_definitions: [
      { ...exercise('b1_ex1', [criterion('b1_ex1_sc_version_negotiation')]), title: 'Build your storefront' },
    ] },
    { id: 'B3', exercise_definitions: [], lesson_plan: plan([concept('Account management')]) },
    { id: 'C1', lesson_plan: plan([
      concept('Account and audience setup'),
      concept('Proposals and packages'),
    ], { demo_scenarios: [
      { tools: ['get_products'], description: 'Product discovery', expected_outcome: 'Products' },
      { tools: ['package'], description: 'Package exploration', expected_outcome: 'Packages' },
    ] }), exercise_definitions: [
      exercise('c1_ex1', [
        criterion('c1_ex1_sc_version_declaration'),
        criterion('c1_ex1_sc_update_media_buy_account'),
      ], [
        { tool: 'get_products', guidance: 'Seeded get_products guidance' },
        { tool: 'package', guidance: 'Seeded package guidance' },
      ]),
    ] },
    { id: 'D1', exercise_definitions: [], lesson_plan: plan([concept('Capability and account handling')]) },
    { id: 'D2', exercise_definitions: [], lesson_plan: plan([concept('Campaign governance architecture')]) },
    { id: 'D4', lesson_plan: plan([
      concept('Phase 3: Validate (~10 min)', 'Run. Check that error responses include recovery_type (transient/correctable/terminal). Done.'),
    ]), exercise_definitions: [
      exercise('d4_validate', [criterion('d4_validate_sc2')]),
    ] },
    { id: 'S1', lesson_plan: plan([
      concept('Refinement protocol'),
      concept('S1 untouched concept'),
    ], { objectives: ['Use refinement protocol for campaign modifications', 'Seeded other objective'] }), exercise_definitions: [
      exercise('s1_ex1', [
        criterion('s1_ex1_sc1'),
        criterion('s1_ex1_sc_update_media_buy_account'),
        criterion('s1_ex1_sc_broadcast_delivery_windows'),
      ], [
        { tool: 'get_media_buys', guidance: 'Seeded get_media_buys guidance' },
        { tool: 'get_media_buy_delivery', guidance: 'Seeded delivery guidance' },
        { tool: 'comply_test_controller', guidance: 'Seeded controller guidance.' },
        { tool: 'create_media_buy', guidance: 'Seeded create guidance.' },
      ]),
    ] },
    { id: 'S2', lesson_plan: plan([concept('S2 untouched concept')]), exercise_definitions: [
      exercise('s2_ex1', [criterion('s2_ex1_sc_tracker_slot_reasoning')]),
    ] },
    { id: 'S3', exercise_definitions: [], lesson_plan: plan([concept('S3 untouched concept')]) },
    { id: 'S4', lesson_plan: plan([concept('Campaign governance protocol')]), exercise_definitions: [
      exercise('e4_ex2', [criterion('e4_ex2_sc1')], [
        { tool: 'check_governance', guidance: 'Call with binding proposed for a valid action. Seeded.' },
        { tool: 'sync_plans', guidance: 'Seeded sync_plans guidance' },
      ]),
    ] },
    { id: 'S6', exercise_definitions: [], lesson_plan: plan([concept('S6 untouched concept')]) },
    { id: 'S7', lesson_plan: plan([
      concept('Organizational hierarchy: two axes, and where operators fit', `Intro. ${S7_OLD_PASSAGE} Outro.`),
    ]), exercise_definitions: [
      exercise('s7_ex1', [criterion('s7_ex1_sc_operator_authorization',
        `Explains the hierarchy ${S7_OLD_CRITERION_PASSAGE}`)]),
    ] },
  ];
}

async function insertModules(client: PoolClient, modules: ModuleRow[]): Promise<void> {
  await client.query('CREATE TABLE certification_modules (id TEXT PRIMARY KEY, lesson_plan JSONB, exercise_definitions JSONB)');
  for (const row of modules) {
    await client.query(
      'INSERT INTO certification_modules (id, lesson_plan, exercise_definitions) VALUES ($1, $2, $3)',
      [row.id, JSON.stringify(row.lesson_plan), JSON.stringify(row.exercise_definitions)],
    );
  }
}

async function readModules(client: PoolClient): Promise<ModuleRow[]> {
  const result = await client.query<ModuleRow>(
    'SELECT id, lesson_plan, exercise_definitions FROM certification_modules ORDER BY id',
  );
  return result.rows;
}

function criterionIds(modules: ModuleRow[]): Record<string, string[]> {
  return Object.fromEntries(modules.map(row => [
    row.id,
    row.exercise_definitions.flatMap(ex => ex.success_criteria.map(c => `${ex.id}/${c.id}`)),
  ]));
}

function mod(modules: ModuleRow[], id: string): ModuleRow {
  const found = modules.find(row => row.id === id);
  if (!found) throw new Error(`Module ${id} missing`);
  return found;
}
function exerciseOf(modules: ModuleRow[], moduleId: string, exerciseId: string): Exercise {
  const found = mod(modules, moduleId).exercise_definitions.find(ex => ex.id === exerciseId);
  if (!found) throw new Error(`Exercise ${exerciseId} missing`);
  return found;
}
function criterionText(modules: ModuleRow[], moduleId: string, exerciseId: string, id: string): string {
  const found = exerciseOf(modules, moduleId, exerciseId).success_criteria.find(c => c.id === id);
  if (!found) throw new Error(`Criterion ${id} missing`);
  return found.text;
}
function conceptOf(modules: ModuleRow[], moduleId: string, topic: string): Concept {
  const found = mod(modules, moduleId).lesson_plan.key_concepts.find(c => c.topic === topic);
  if (!found) throw new Error(`Concept "${topic}" missing from ${moduleId}`);
  return found;
}
function topics(modules: ModuleRow[], moduleId: string): string[] {
  return mod(modules, moduleId).lesson_plan.key_concepts.map(c => c.topic);
}

describe.skipIf(!process.env.DATABASE_URL)('migrations 639-642: 3.3 GA curriculum refresh', () => {
  const schema = `curriculum_ga_refresh_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool;
  let client: PoolClient;

  async function runMigrations(...sql: string[]): Promise<void> {
    for (const migration of sql) await client.query(migration);
  }

  async function expectRaises(prior: string[], migration: string, error: string, mutate: (rows: ModuleRow[]) => void) {
    await client.query('ROLLBACK');
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA ${schema}_x`);
    await client.query(`SET LOCAL search_path TO ${schema}_x`);
    const rows = seedModules();
    mutate(rows);
    await insertModules(client, rows);
    await runMigrations(...prior);
    await client.query('SAVEPOINT before_migration');
    await expect(client.query(migration)).rejects.toThrow(error);
    await client.query('ROLLBACK TO SAVEPOINT before_migration');
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    client = await pool.connect();
  });

  beforeEach(async () => {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema}`);
    await insertModules(client, seedModules());
  });

  afterEach(async () => {
    await client?.query('ROLLBACK');
  });

  afterAll(async () => {
    client?.release();
    await pool?.end();
  });

  it('keeps every success-criterion ID, which completion requires', async () => {
    const before = criterionIds(await readModules(client));

    await runMigrations(MIG_639, MIG_640, MIG_641, MIG_642);

    expect(criterionIds(await readModules(client))).toEqual(before);
  });

  describe('639: A1 learner-first opening', () => {
    it('prepends the opening concept and rewrites the two anchored concepts', async () => {
      await runMigrations(MIG_639);

      const a1 = await readModules(client);
      expect(topics(a1, 'A1')).toEqual([
        'Start where the learner is',
        'Agentic vs traditional programmatic',
        'The protocol hierarchy',
        'A1 untouched concept',
      ]);
      expect(conceptOf(a1, 'A1', 'Start where the learner is').teaching_notes)
        .toContain('First ask, in plain words, what the learner does');
      expect(conceptOf(a1, 'A1', 'Agentic vs traditional programmatic').teaching_notes)
        .toContain('After the opening, run the demonstration on turn 2 or 3');
      const hierarchy = conceptOf(a1, 'A1', 'The protocol hierarchy').teaching_notes ?? '';
      expect(hierarchy).toContain('It runs over two transports: MCP');
      expect(hierarchy).not.toContain('built on MCP');
      expect(conceptOf(a1, 'A1', 'A1 untouched concept').teaching_notes).toBe('Seeded notes for A1 untouched concept');
    });

    it('is idempotent', async () => {
      await runMigrations(MIG_639);
      const once = await readModules(client);
      await runMigrations(MIG_639);
      expect(await readModules(client)).toEqual(once);
    });

    it('raises when "The protocol hierarchy" is missing', async () => {
      await expectRaises([], MIG_639, 'A1 key concept "The protocol hierarchy" not found', rows => {
        const a1 = mod(rows, 'A1');
        a1.lesson_plan.key_concepts = a1.lesson_plan.key_concepts.filter(c => c.topic !== 'The protocol hierarchy');
      });
    });
  });

  describe('640: S1 sandbox guidance', () => {
    it('adds the sandbox guidance, second delivery action, criterion text, concept and objective', async () => {
      await runMigrations(MIG_640);

      const s1 = await readModules(client);
      const actions = exerciseOf(s1, 'S1', 's1_ex1').sandbox_actions;
      expect(actions.map(a => a.tool)).toEqual([
        'get_media_buys', 'get_media_buy_delivery', 'get_media_buy_delivery', 'comply_test_controller', 'create_media_buy',
      ]);
      expect(actions[1].guidance).toBe('Seeded delivery guidance');
      expect(actions[2].guidance).toContain('seed_mb_broadcast_q4');
      expect(actions[3].guidance).toMatch(/^Seeded controller guidance\. Every controller call references the account with sandbox: true/);
      expect(actions[4].guidance).toMatch(/^Seeded create guidance\. For the keyword part, use a search or retail-media product/);
      expect(criterionText(s1, 'S1', 's1_ex1', 's1_ex1_sc1'))
        .toContain('Negotiates before the buy with refine_proposals');
      expect(topics(s1, 'S1')).toEqual(['Refining proposals and changing buys', 'S1 untouched concept']);
      expect(conceptOf(s1, 'S1', 'Refining proposals and changing buys').teaching_notes)
        .toContain('refine_proposals is the negotiation');
      expect(mod(s1, 'S1').lesson_plan.objectives).toEqual([
        'Negotiate with refine_proposals before the buy, and change live buys with update_media_buy',
        'Seeded other objective',
      ]);
    });

    it('is idempotent', async () => {
      await runMigrations(MIG_640);
      const once = await readModules(client);
      await runMigrations(MIG_640);
      expect(await readModules(client)).toEqual(once);
    });

    it('raises when S1 has no comply_test_controller action', async () => {
      await expectRaises([], MIG_640,
        'Expected exactly one comply_test_controller sandbox action in exercise s1_ex1 of module S1, found 0',
        rows => {
          const ex = exerciseOf(rows, 'S1', 's1_ex1');
          ex.sandbox_actions = ex.sandbox_actions.filter(a => a.tool !== 'comply_test_controller');
        });
    });

    it('raises when S1 has no get_media_buy_delivery action to anchor on', async () => {
      await expectRaises([], MIG_640, 'No get_media_buy_delivery sandbox action in exercise s1_ex1 of module S1', rows => {
        const ex = exerciseOf(rows, 'S1', 's1_ex1');
        ex.sandbox_actions = ex.sandbox_actions.filter(a => a.tool !== 'get_media_buy_delivery');
      });
    });
  });

  describe('641: 3.3 GA refresh', () => {
    it('rewrites criterion texts', async () => {
      await runMigrations(MIG_641);

      const m = await readModules(client);
      expect(criterionText(m, 'A2', 'a2_ex1', 'a2_ex1_sc_version_negotiation')).toContain('adcp.supported_versions');
      expect(criterionText(m, 'B1', 'b1_ex1', 'b1_ex1_sc_version_negotiation'))
        .toContain('oldest release it supports in that major');
      expect(criterionText(m, 'C1', 'c1_ex1', 'c1_ex1_sc_version_declaration')).toContain('without a pin');
      expect(criterionText(m, 'C1', 'c1_ex1', 'c1_ex1_sc_update_media_buy_account'))
        .toContain('by the account_id the seller returned');
      expect(criterionText(m, 'S1', 's1_ex1', 's1_ex1_sc_update_media_buy_account'))
        .toContain('by the account_id the seller returned');
      expect(criterionText(m, 'D4', 'd4_validate', 'd4_validate_sc2')).toBe(
        'Error responses include recovery (transient, correctable, or terminal) and meaningful messages',
      );
      expect(criterionText(m, 'S4', 'e4_ex2', 'e4_ex2_sc1')).toContain('intent check');
      expect(criterionText(m, 'S2', 's2_ex1', 's2_ex1_sc_tracker_slot_reasoning'))
        .toContain('a format that declares none makes no slot claim');
      const s7 = criterionText(m, 'S7', 's7_ex1', 's7_ex1_sc_operator_authorization');
      expect(s7).toContain('Explains the hierarchy and reasons about what the seller\'s require_operator_auth selects');
      expect(s7).not.toContain(S7_OLD_CRITERION_PASSAGE);
    });

    it('replaces concept notes and passages, preserving other keys on the concept', async () => {
      await runMigrations(MIG_641);

      const m = await readModules(client);
      const a2b = conceptOf(m, 'A2B', A2B_TOPIC);
      expect(a2b.explanation).toBe(A2B_EXPLANATION);
      expect(a2b.teaching_notes).toBe(
        'Poll tasks/get every few seconds; it builds the muscle memory. From 3.3 a submitted response may carry expected_confirmation_at, when a booking round or manual review is expected to finish. When it is present, check status at that time instead of polling every few seconds; it is an estimate, not a commitment.',
      );
      expect(conceptOf(m, 'A3', 'Accounts and billing').teaching_notes)
        .toBe('Accounts. sync_accounts opens accounts and establishes billing relationships, and returns an account_id that every later call uses; list_accounts lists them. More.');
      expect(conceptOf(m, 'A3', 'Media buy beyond the basics').teaching_notes).toContain('compact lifecycle');
      expect(conceptOf(m, 'B3', 'Account management').teaching_notes).toContain('From 3.3, return an account_id');
      expect(conceptOf(m, 'D1', 'Capability and account handling').teaching_notes).toContain('SHOULD in 3.3, MUST in 4.0');
      expect(conceptOf(m, 'C1', 'Account and audience setup').teaching_notes).toContain('Store the account_id');
      expect(conceptOf(m, 'C1', 'Proposals and packages').teaching_notes).toContain('request_proposals returns priced proposals');
      expect(conceptOf(m, 'D2', 'Campaign governance architecture').teaching_notes).toContain('sync_governance');
      expect(conceptOf(m, 'S4', 'Campaign governance protocol').teaching_notes).toContain('infers the check type');
      expect(conceptOf(m, 'D4', 'Phase 3: Validate (~10 min)').teaching_notes)
        .toBe('Run. Check that error responses include recovery (transient, correctable, or terminal), and that an error ending a state-changing request can say whether the change applied with mutation_outcome (not_applied, unknown, or applied; new in 3.3). Done.');
      const s7 = conceptOf(m, 'S7', 'Organizational hierarchy: two axes, and where operators fit').teaching_notes ?? '';
      expect(s7).toMatch(/^Intro\. The operator axis surfaces at runtime in the Accounts Protocol: an account is opened for a \{brand, operator\} pair/);
      expect(s7).toMatch(/is deprecated from 3\.3\. Outro\.$/);
    });

    it('appends the taught-not-graded concepts after the existing ones', async () => {
      const before = await readModules(client);
      await runMigrations(MIG_641);

      const after = await readModules(client);
      const appended: Record<string, string> = {
        A2: 'Two ways to buy',
        S1: 'AdCP 3.3 scheduled and human-gated buying',
        B3: 'AdCP 3.3 delivery reporting',
        D1: 'AdCP 3.3 server rules',
        S2: 'AdCP 3.3 creative assignment',
        S3: 'AdCP 3.3 signals and audience updates',
        S4: 'AdCP 3.3 governance updates',
        S6: 'AdCP 3.3 agent identity and bounds',
        S7: 'AdCP 3.3 identity rules',
      };
      for (const [moduleId, topic] of Object.entries(appended)) {
        expect(topics(after, moduleId).at(-1), moduleId).toBe(topic);
        expect(topics(after, moduleId).length, moduleId).toBe(topics(before, moduleId).length + 1);
        expect(conceptOf(after, moduleId, topic).teaching_notes, moduleId).toBeTruthy();
      }
    });

    it('replaces the C1 package action and demo scenario with request_proposals', async () => {
      await runMigrations(MIG_641);

      const m = await readModules(client);
      expect(exerciseOf(m, 'C1', 'c1_ex1').sandbox_actions).toEqual([
        { tool: 'get_products', guidance: 'Seeded get_products guidance' },
        { tool: 'request_proposals', guidance: 'Request proposals for the same brief and compare their packages, budget points, and forecasts.' },
      ]);
      expect(mod(m, 'C1').lesson_plan.demo_scenarios).toEqual([
        { tools: ['get_products'], description: 'Product discovery', expected_outcome: 'Products' },
        {
          tools: ['request_proposals'],
          description: 'Proposal and package exploration',
          expected_outcome: 'See proposals built from packages, with budget points and forecasts for planning',
        },
      ]);
    });

    it('rewrites the S4 check_governance guidance without touching its sibling action', async () => {
      await runMigrations(MIG_641);

      const actions = exerciseOf(await readModules(client), 'S4', 'e4_ex2').sandbox_actions;
      expect(actions[0].tool).toBe('check_governance');
      expect(actions[0].guidance).toMatch(/^Send intent checks \(tool plus payload/);
      expect(actions[1]).toEqual({ tool: 'sync_plans', guidance: 'Seeded sync_plans guidance' });
    });

    it('is idempotent', async () => {
      await runMigrations(MIG_641);
      const once = await readModules(client);
      await runMigrations(MIG_641);
      expect(await readModules(client)).toEqual(once);
    });

    it('raises when the C1 package action is missing', async () => {
      await expectRaises([], MIG_641,
        'Expected exactly one package sandbox action in exercise c1_ex1 of module C1, found 0',
        rows => {
          const ex = exerciseOf(rows, 'C1', 'c1_ex1');
          ex.sandbox_actions = ex.sandbox_actions.filter(a => a.tool !== 'package');
        });
    });

    it('raises when a passage to replace is missing', async () => {
      await expectRaises([], MIG_641, 'Criterion s7_ex1_sc_operator_authorization does not contain the passage to replace', rows => {
        exerciseOf(rows, 'S7', 's7_ex1').success_criteria[0].text = 'Something else entirely';
      });
    });
  });

  describe('642: storefront and inventory roles', () => {
    it('inserts the role concept after the catalog concept and rewrites the catalog wording', async () => {
      await runMigrations(MIG_642);

      const m = await readModules(client);
      expect(topics(m, 'B1')).toEqual([
        'Product catalog design',
        'Two jobs behind a sales agent: storefront and inventory (non-normative)',
        'B1 untouched concept',
      ]);
      expect(conceptOf(m, 'B1', 'Product catalog design').teaching_notes)
        .toBe('Design products. The catalog is what buyer agents shop from. Keep it fresh.');
      expect(conceptOf(m, 'B1', 'Two jobs behind a sales agent: storefront and inventory (non-normative)').teaching_notes)
        .toContain('RFC #8993');
    });

    it('appends the discussion prompt, retitles b1_ex1, and extends the A3 concept', async () => {
      await runMigrations(MIG_642);

      const m = await readModules(client);
      expect(mod(m, 'B1').lesson_plan.discussion_prompts).toEqual([
        'Seeded prompt',
        expect.stringMatching(/^Your publisher sells display and video through an ad server/),
      ]);
      expect(exerciseOf(m, 'B1', 'b1_ex1').title).toBe('Design your catalog');
      const a3 = conceptOf(m, 'A3', 'Sell-side identity and authorization').teaching_notes ?? '';
      expect(a3).toMatch(/^Seeded identity notes\. Also name, in two sentences, the two jobs/);
      expect(a3).toContain('RFC #8993');
    });

    it('runs after 641 without disturbing A3\'s rewritten concepts', async () => {
      await runMigrations(MIG_641, MIG_642);

      const m = await readModules(client);
      expect(conceptOf(m, 'A3', 'Accounts and billing').teaching_notes).toContain('returns an account_id');
      expect(conceptOf(m, 'A3', 'Sell-side identity and authorization').teaching_notes).toContain('RFC #8993');
    });

    it('is idempotent', async () => {
      await runMigrations(MIG_642);
      const once = await readModules(client);
      await runMigrations(MIG_642);
      const twice = await readModules(client);
      expect(twice).toEqual(once);
      expect(topics(twice, 'B1').filter(t => t.startsWith('Two jobs'))).toHaveLength(1);
      expect(mod(twice, 'B1').lesson_plan.discussion_prompts).toHaveLength(2);
    });

    it('raises when "Product catalog design" is missing', async () => {
      await expectRaises([], MIG_642, 'B1 key concept "Product catalog design" not found', rows => {
        const b1 = mod(rows, 'B1');
        b1.lesson_plan.key_concepts = b1.lesson_plan.key_concepts.filter(c => c.topic !== 'Product catalog design');
      });
    });
  });

  it('drops every helper function', async () => {
    await runMigrations(MIG_639, MIG_640, MIG_641, MIG_642);

    for (const helper of MIGRATION_HELPERS) {
      const result = await client.query<{ dropped: boolean }>('SELECT to_regprocedure($1) IS NULL AS dropped', [helper]);
      expect(result.rows[0].dropped, helper).toBe(true);
    }
  });
});
