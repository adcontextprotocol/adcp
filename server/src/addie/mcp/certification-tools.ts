/**
 * Certification tools for Addie
 *
 * Enables Addie to deliver certification modules, run exercises,
 * conduct evaluations, and manage learner progress.
 */

import type { AddieTool } from '../types.js';
import type { MemberContext } from '../member-context.js';
import * as certDb from '../../db/certification-db.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('certification-tools');

/**
 * Issue a Certifier badge for an awarded credential.
 * Handles expiry logic (tier 1 = no expiry, others = 2 years) and records the credential ID.
 */
async function issueCertifierBadge(
  userId: string,
  credId: string,
  cred: { name: string; tier: number; certifier_group_id: string | null },
  memberContext: MemberContext | null,
  extraAttributes?: Record<string, string>,
): Promise<string | null> {
  if (!cred.certifier_group_id || !memberContext?.workos_user) return null;

  try {
    const { issueCredential, isCertifierConfigured } = await import('../../services/certifier-client.js');
    if (!isCertifierConfigured()) return null;

    const expiryDate = cred.tier === 1 ? undefined : (() => {
      const d = new Date();
      d.setFullYear(d.getFullYear() + 2);
      return d.toISOString().split('T')[0];
    })();

    const credential = await issueCredential({
      groupId: cred.certifier_group_id,
      recipient: {
        name: `${memberContext.workos_user.first_name} ${memberContext.workos_user.last_name}`,
        email: memberContext.workos_user.email,
      },
      ...(expiryDate ? { expiryDate } : {}),
      customAttributes: {
        'custom.credential': cred.name,
        'custom.tier': String(cred.tier),
        ...extraAttributes,
      },
    });

    await certDb.awardCredential(userId, credId, credential.id, credential.publicId);
    logger.info({ credentialId: credential.id, userId, credId }, 'Credential issued via Certifier');
    return credential.publicId || credential.id;
  } catch (certError) {
    logger.error({ error: certError, credId }, 'Failed to issue Certifier credential (continuing)');
    return null;
  }
}

// =====================================================
// TOOL DEFINITIONS
// =====================================================

export const CERTIFICATION_TOOLS: AddieTool[] = [
  {
    name: 'list_certification_tracks',
    description: 'List all AdCP certification tracks and the learner\'s progress in each. Returns track names, descriptions, module counts, and completion status.',
    usage_hints: 'use for "certification", "what certifications", "training program", "learn adcp", "get certified"',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_certification_module',
    description: 'Preview a module\'s content without starting it. Returns lesson plan, exercises, and assessment criteria for read-only browsing. Does NOT record progress or check prerequisites. Use start_certification_module instead when the learner wants to actually take a module.',
    usage_hints: 'use for "tell me about module X", "what does module A2 cover", "preview module"',
    input_schema: {
      type: 'object',
      properties: {
        module_id: { type: 'string', description: 'Module ID (e.g., A1, B2, C3)' },
      },
      required: ['module_id'],
    },
  },
  {
    name: 'start_certification_module',
    description: 'Begin teaching a certification module. Records the learner as started, checks prerequisites and membership, then returns the lesson plan with teaching instructions. Always call this (not get_certification_module) when the learner wants to take a module.',
    usage_hints: 'use for "start module", "begin lesson", "take course", "I want to do module A1"',
    input_schema: {
      type: 'object',
      properties: {
        module_id: { type: 'string', description: 'Module ID to start (e.g., A1, B2)' },
      },
      required: ['module_id'],
    },
  },
  {
    name: 'complete_certification_module',
    description: 'Mark a certification module as completed with scores across assessment dimensions (0-100 each). Call ONLY after: (1) covering all key concepts from the lesson plan, (2) the learner completing any exercises, and (3) a multi-turn discussion where the learner demonstrated understanding. NEVER call this in the same turn as start_certification_module — a module must span multiple conversational turns.',
    usage_hints: 'use when learner has completed a module\'s content and exercises',
    input_schema: {
      type: 'object',
      properties: {
        module_id: { type: 'string', description: 'Module ID to complete' },
        scores: {
          type: 'object',
          description: 'Scores per assessment dimension (0-100 each)',
          properties: {
            conceptual_understanding: { type: 'number', description: 'Understanding of core concepts (0-100)' },
            practical_knowledge: { type: 'number', description: 'Ability to apply concepts to realistic scenarios (0-100)' },
            problem_solving: { type: 'number', description: 'Can diagnose issues and propose solutions (0-100)' },
            communication_clarity: { type: 'number', description: 'Can explain AdCP concepts clearly to others (0-100)' },
            protocol_fluency: { type: 'number', description: 'Proper use of AdCP terminology and patterns (0-100)' },
          },
        },
      },
      required: ['module_id', 'scores'],
    },
  },
  {
    name: 'get_learner_progress',
    description: 'Get the current learner\'s progress across all certification modules and tracks. Shows which modules are completed, in progress, or not started, plus any earned certificates.',
    usage_hints: 'use for "my progress", "certification status", "what have I completed"',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'test_out_modules',
    description: 'Mark modules as tested out after a placement assessment confirms the learner already has the knowledge. Only call this after conducting a thorough assessment — ask probing questions per module topic, not just surface-level familiarity. Never test out capstone modules (E1-E4). Does not award scores since no formal coursework was completed, but satisfies prerequisites for advancement.',
    usage_hints: 'use after assess_certification_readiness when learner demonstrates mastery of specific modules',
    input_schema: {
      type: 'object',
      properties: {
        module_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Module IDs to mark as tested out (e.g., ["A1", "A2", "B1"]). Cannot include capstone modules (E1-E4).',
        },
        assessment_notes: {
          type: 'string',
          description: 'Brief summary of how the learner demonstrated knowledge of these modules.',
        },
      },
      required: ['module_ids', 'assessment_notes'],
    },
  },
  {
    name: 'start_certification_exam',
    description: 'Begin a specialist capstone module (E1: Media Buy, E2: Creative, E3: Signals, E4: Governance). The learner must hold the Practitioner credential. Returns the capstone format, lab exercises, and assessment criteria. You (Addie) will conduct the combined hands-on lab and adaptive exam.',
    usage_hints: 'use for "take the exam", "start capstone", "specialist exam", "ready for certification", "start E1", "media buy capstone"',
    input_schema: {
      type: 'object',
      properties: {
        module_id: {
          type: 'string',
          enum: ['E1', 'E2', 'E3', 'E4'],
          description: 'Capstone module ID: E1 (Media Buy), E2 (Creative), E3 (Signals), E4 (Governance)',
        },
      },
      required: ['module_id'],
    },
  },
  {
    name: 'complete_certification_exam',
    description: 'Finalize a specialist capstone with scores. If passing (70%+ in each dimension and overall), awards the protocol-specific specialist credential and triggers Certifier badge issuance. Do not call until both the lab phase and exam phase are complete. Do not call if the learner asked to stop early.',
    usage_hints: 'use after completing the capstone lab and oral exam assessment',
    input_schema: {
      type: 'object',
      properties: {
        attempt_id: { type: 'string', description: 'Exam attempt ID returned from start_certification_exam' },
        scores: {
          type: 'object',
          description: 'Scores per assessment dimension (0-100 each)',
          properties: {
            conceptual_understanding: { type: 'number', description: 'Understanding of core protocol concepts (0-100)' },
            practical_knowledge: { type: 'number', description: 'Ability to apply protocol concepts to realistic scenarios (0-100)' },
            problem_solving: { type: 'number', description: 'Can diagnose issues and propose solutions (0-100)' },
            communication_clarity: { type: 'number', description: 'Can explain decisions and reasoning clearly (0-100)' },
            protocol_fluency: { type: 'number', description: 'Proper use of protocol terminology and patterns (0-100)' },
          },
        },
      },
      required: ['attempt_id', 'scores'],
    },
  },
];

// =====================================================
// HANDLER CREATION
// =====================================================

type ToolHandler = (input: Record<string, unknown>) => Promise<string>;

export function createCertificationToolHandlers(
  memberContext: MemberContext | null,
): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();

  const getUserId = (): string | null => {
    return memberContext?.workos_user?.workos_user_id || null;
  };

  // ----- list_certification_tracks -----
  handlers.set('list_certification_tracks', async () => {
    try {
      const tracks = await certDb.getTracks();
      const modules = await certDb.getModules();
      const credentials = await certDb.getCredentials();
      const userId = getUserId();

      let trackProgress: certDb.TrackProgress[] = [];
      let userCredentials: certDb.UserCredential[] = [];
      if (userId) {
        [trackProgress, userCredentials] = await Promise.all([
          certDb.getTrackProgress(userId),
          certDb.getUserCredentials(userId),
        ]);
      }

      const heldCredentials = new Set(userCredentials.map(c => c.credential_id));
      const progressMap = new Map(trackProgress.map(tp => [tp.track_id, tp]));

      const lines: string[] = ['# AdCP certification program\n'];
      lines.push('Three-tier credential system: Basics → Practitioner → Specialist\n');

      // Group credentials by tier
      const tiers = [
        { tier: 1, label: 'Level 1 — Basics', desc: 'Free and open to everyone' },
        { tier: 2, label: 'Level 2 — Practitioner', desc: 'Requires membership' },
        { tier: 3, label: 'Level 3 — Specialist', desc: 'Protocol-specific mastery' },
      ];

      for (const { tier, label, desc } of tiers) {
        const tierCredentials = credentials.filter(c => c.tier === tier);
        lines.push(`## ${label}`);
        lines.push(`*${desc}*\n`);

        for (const cred of tierCredentials) {
          const held = heldCredentials.has(cred.id);
          const status = held ? ' — Earned' : '';
          lines.push(`### ${cred.name}${status}`);
          lines.push(cred.description || '');
          lines.push(`Required modules: ${cred.required_modules.join(', ')}`);
          if (cred.requires_any_track_complete) {
            lines.push('Plus: complete at least one specialization track (B, C, or D)');
          }
          if (cred.requires_credential) {
            lines.push(`Requires: ${cred.requires_credential} credential`);
          }
          lines.push('');
        }
      }

      // Show track/module structure
      lines.push('---');
      lines.push('## Tracks and modules\n');

      for (const track of tracks) {
        const tp = progressMap.get(track.id);
        const trackModules = modules.filter(m => m.track_id === track.id);

        lines.push(`### Track ${track.id}: ${track.name}`);
        lines.push(track.description || '');
        if (tp) {
          lines.push(`Progress: ${tp.completed_modules}/${tp.total_modules} modules completed`);
        }
        lines.push('');

        for (const mod of trackModules) {
          const freeLabel = mod.is_free ? ' (free)' : '';
          lines.push(`- ${mod.id}: ${mod.title} — ${mod.duration_minutes} min, ${mod.format}${freeLabel}`);
        }
        lines.push('');
      }

      lines.push('---');
      lines.push('Modules A1 and A2 are free for everyone. Other modules require AgenticAdvertising.org membership.');
      lines.push('To start a module, say "start module [ID]" (e.g., "start module A1").');
      lines.push('To start a specialist capstone, say "start capstone E1" (or E2/E3/E4).');
      lines.push('Already familiar with AdCP? Say "assess my level" to take a placement assessment and skip modules you already know.');

      return lines.join('\n');
    } catch (error) {
      logger.error({ error }, 'Failed to list certification tracks');
      return 'Failed to load certification tracks. Please try again.';
    }
  });

  // ----- get_certification_module -----
  handlers.set('get_certification_module', async (input) => {
    try {
      const moduleId = (input.module_id as string).toUpperCase();
      const mod = await certDb.getModule(moduleId);
      if (!mod) return `Module "${moduleId}" not found. Use list_certification_tracks to see available modules.`;

      // Check access
      if (!mod.is_free && !memberContext?.is_member) {
        return `Module ${moduleId} (${mod.title}) requires AgenticAdvertising.org membership. Modules A1 and A2 are free — start there!`;
      }

      const lines: string[] = [
        `# Module ${mod.id}: ${mod.title}`,
        '',
        mod.description || '',
        '',
        `**Format**: ${mod.format} | **Duration**: ${mod.duration_minutes} minutes`,
        mod.prerequisites?.length ? `**Prerequisites**: ${mod.prerequisites.join(', ')}` : '',
      ];

      if (mod.lesson_plan) {
        const lp = mod.lesson_plan as certDb.LessonPlan;
        lines.push('', '## Learning objectives');
        lp.objectives?.forEach(o => lines.push(`- ${o}`));

        lines.push('', '## Key concepts');
        lp.key_concepts?.forEach(kc => lines.push(`### ${kc.topic}`, kc.explanation, ''));

        if (lp.discussion_prompts?.length) {
          lines.push('## Discussion prompts');
          lp.discussion_prompts.forEach(dp => lines.push(`- ${dp}`));
        }

        if (lp.demo_scenarios?.length) {
          lines.push('', '## Demo scenarios');
          lp.demo_scenarios.forEach(ds => {
            lines.push(`### ${ds.description}`);
            lines.push(`Tools: ${ds.tools.join(', ')}`);
            lines.push(`Expected outcome: ${ds.expected_outcome}`);
            lines.push('');
          });
        }
      }

      if (mod.exercise_definitions) {
        const exercises = mod.exercise_definitions as certDb.ExerciseDefinition[];
        lines.push('', '## Exercises');
        for (const ex of exercises) {
          lines.push(`### ${ex.title}`);
          lines.push(ex.description);
          lines.push('**Steps**:');
          ex.sandbox_actions.forEach(a => lines.push(`- Use \`${a.tool}\`: ${a.guidance}`));
          lines.push('**Success criteria**:');
          ex.success_criteria.forEach(sc => lines.push(`- ${sc}`));
          lines.push('');
        }
      }

      if (mod.assessment_criteria) {
        const ac = mod.assessment_criteria as certDb.AssessmentCriteria;
        lines.push('', `## Assessment (passing threshold: ${ac.passing_threshold}%)`);
        ac.dimensions?.forEach(d => {
          lines.push(`- **${d.name}** (weight: ${d.weight}): ${d.description}`);
          if (d.scoring_guide && Object.keys(d.scoring_guide).length > 0) {
            if (d.scoring_guide.high) lines.push(`  - High (80-100): ${d.scoring_guide.high}`);
            if (d.scoring_guide.medium) lines.push(`  - Medium (50-79): ${d.scoring_guide.medium}`);
            if (d.scoring_guide.low) lines.push(`  - Low (0-49): ${d.scoring_guide.low}`);
          }
        });
      }

      return lines.join('\n');
    } catch (error) {
      logger.error({ error }, 'Failed to get certification module');
      return 'Failed to load module. Please try again.';
    }
  });

  // ----- start_certification_module -----
  handlers.set('start_certification_module', async (input) => {
    const userId = getUserId();
    if (!userId) return 'You need to be logged in to start a certification module. Link your account first.';

    try {
      const moduleId = (input.module_id as string).toUpperCase();
      const mod = await certDb.getModule(moduleId);
      if (!mod) return `Module "${moduleId}" not found.`;

      if (!mod.is_free && !memberContext?.is_member) {
        return `Module ${moduleId} requires membership. Modules A1 and A2 are free — try those first!`;
      }

      const prereqs = await certDb.checkPrerequisites(userId, moduleId);
      if (!prereqs.met) {
        return `You need to complete these modules first: ${prereqs.missing.join(', ')}`;
      }

      await certDb.startModule(userId, moduleId);

      // Return the lesson plan so Addie can teach it
      const lines: string[] = [
        `Module ${mod.id} started: **${mod.title}**`,
        '',
      ];

      if (mod.lesson_plan) {
        const lp = mod.lesson_plan as certDb.LessonPlan;
        lines.push('## Teaching guide');
        lines.push('');
        lines.push('**Objectives** (what the learner should know after this module):');
        lp.objectives?.forEach(o => lines.push(`- ${o}`));
        lines.push('');

        lines.push('**Key concepts to cover** (use Socratic method — ask probing questions, don\'t just lecture):');
        lp.key_concepts?.forEach(kc => {
          lines.push(`- **${kc.topic}**: ${kc.explanation}`);
        });
        lines.push('');

        if (lp.discussion_prompts?.length) {
          lines.push('**Discussion prompts** (use these to check understanding):');
          lp.discussion_prompts.forEach(dp => lines.push(`- ${dp}`));
          lines.push('');
        }

        if (lp.demo_scenarios?.length) {
          lines.push('**Live demos** (run these against sandbox agents):');
          lp.demo_scenarios.forEach(ds => {
            lines.push(`- ${ds.description} (tools: ${ds.tools.join(', ')})`);
          });
          lines.push('');
        }
      }

      if (mod.exercise_definitions) {
        const exercises = mod.exercise_definitions as certDb.ExerciseDefinition[];
        lines.push('**Exercises** (guide the learner through these):');
        for (const ex of exercises) {
          lines.push(`- ${ex.title}: ${ex.description}`);
        }
        lines.push('');
      }

      if (mod.assessment_criteria) {
        const ac = mod.assessment_criteria as certDb.AssessmentCriteria;
        lines.push(`**Assessment** (passing: ${ac.passing_threshold}% — use these rubrics when scoring):`);
        ac.dimensions?.forEach(d => {
          lines.push(`- **${d.name}** (weight: ${d.weight}): ${d.description}`);
          if (d.scoring_guide && Object.keys(d.scoring_guide).length > 0) {
            if (d.scoring_guide.high) lines.push(`  - High (80-100): ${d.scoring_guide.high}`);
            if (d.scoring_guide.medium) lines.push(`  - Medium (50-79): ${d.scoring_guide.medium}`);
            if (d.scoring_guide.low) lines.push(`  - Low (0-49): ${d.scoring_guide.low}`);
          }
        });
        lines.push('');
      }

      lines.push('Begin teaching this module now. Start by welcoming the learner and giving a brief overview of what they\'ll learn. Use the Socratic method — ask questions to draw out understanding rather than just explaining. Score honestly against the rubric — do not inflate scores to be encouraging.');

      return lines.join('\n');
    } catch (error) {
      logger.error({ error }, 'Failed to start certification module');
      return 'Failed to start module. Please try again.';
    }
  });

  // ----- complete_certification_module -----
  handlers.set('complete_certification_module', async (input) => {
    const userId = getUserId();
    if (!userId) return 'You need to be logged in.';

    try {
      const moduleId = (input.module_id as string).toUpperCase();
      const scores = input.scores as Record<string, number>;

      if (!scores || typeof scores !== 'object') return 'Scores are required to complete a module.';

      // Validate score values
      const scoreValues = Object.values(scores);
      if (scoreValues.length === 0 || !scoreValues.every(v => typeof v === 'number' && v >= 0 && v <= 100)) {
        return 'All score values must be numbers between 0 and 100.';
      }

      await certDb.completeModule(userId, moduleId, scores);

      const avgScore = Object.values(scores).reduce((a, b) => a + b, 0) / Object.values(scores).length;

      const lines = [
        `Module ${moduleId} completed!`,
        '',
        '**Scores**:',
        ...Object.entries(scores).map(([dim, score]) =>
          `- ${dim.replace(/_/g, ' ')}: ${score}/100`
        ),
        '',
        `**Average**: ${Math.round(avgScore)}/100`,
      ];

      // Auto-check and award credentials
      try {
        const awarded = await certDb.checkAndAwardCredentials(userId);
        if (awarded.length > 0) {
          const creds = await certDb.getCredentials();
          const credMap = new Map(creds.map(c => [c.id, c]));

          lines.push('');
          for (const credId of awarded) {
            const cred = credMap.get(credId);
            if (cred) {
              lines.push(`**Credential earned: ${cred.name}!**`);
              const issued = await issueCertifierBadge(userId, credId, cred, memberContext);
              if (issued) {
                lines.push('Your digital credential has been issued and emailed to you. You can share it on LinkedIn.');
              }
            }
          }
        }
      } catch (credError) {
        logger.error({ error: credError }, 'Failed to check credential eligibility');
      }

      lines.push('');
      lines.push('Check your progress with "show my certification progress".');

      return lines.join('\n');
    } catch (error) {
      logger.error({ error }, 'Failed to complete certification module');
      return 'Failed to record module completion. Please try again.';
    }
  });

  // ----- get_learner_progress -----
  handlers.set('get_learner_progress', async () => {
    const userId = getUserId();
    if (!userId) return 'You need to be logged in to see your certification progress.';

    try {
      const [progress, trackProgress, credentials, userCredentials, tracks] = await Promise.all([
        certDb.getProgress(userId),
        certDb.getTrackProgress(userId),
        certDb.getCredentials(),
        certDb.getUserCredentials(userId),
        certDb.getTracks(),
      ]);

      const lines: string[] = ['# Your certification progress\n'];

      // Show earned credentials first
      const heldSet = new Set(userCredentials.map(c => c.credential_id));
      const earnedCreds = credentials.filter(c => heldSet.has(c.id));
      const nextCreds = credentials.filter(c => !heldSet.has(c.id));

      if (earnedCreds.length > 0) {
        lines.push('## Earned credentials');
        for (const cred of earnedCreds) {
          const uc = userCredentials.find(u => u.credential_id === cred.id);
          lines.push(`- **${cred.name}** (Level ${cred.tier}) — earned ${uc ? new Date(uc.awarded_at).toLocaleDateString() : ''}`);
        }
        lines.push('');
      }

      // Show next credential to earn
      if (nextCreds.length > 0) {
        const nextCred = nextCreds[0];
        const { eligible, missing } = await certDb.checkCredentialEligibility(userId, nextCred.id);
        lines.push('## Next credential');
        lines.push(`**${nextCred.name}** (Level ${nextCred.tier})`);
        if (eligible) {
          lines.push('You are eligible! This credential will be auto-awarded on your next module completion.');
        } else {
          lines.push(`Remaining: ${missing.join('; ')}`);
        }
        lines.push('');
      }

      // Show track progress
      const trackMap = new Map(tracks.map(t => [t.id, t]));
      lines.push('## Track progress');

      for (const tp of trackProgress) {
        const track = trackMap.get(tp.track_id);
        const pct = tp.total_modules > 0 ? Math.round((tp.completed_modules / tp.total_modules) * 100) : 0;
        lines.push(`- Track ${tp.track_id} (${track?.name || tp.track_id}): ${tp.completed_modules}/${tp.total_modules} modules (${pct}%)`);
      }
      lines.push('');

      const moduleProgress = progress.filter(p => p.status !== 'not_started');
      if (moduleProgress.length > 0) {
        lines.push('## Module details');
        for (const p of moduleProgress) {
          const status = p.status === 'completed' ? 'completed' : p.status === 'tested_out' ? 'tested out' : 'in progress';
          lines.push(`- ${p.module_id}: ${status}${p.score ? ` (${Math.round(Object.values(p.score).reduce((a, b) => a + b, 0) / Object.values(p.score).length)}% avg)` : ''}`);
        }
      }

      if (progress.length === 0) {
        lines.push('You haven\'t started any modules yet. Say "start module A1" to begin with the foundations!');
      }

      return lines.join('\n');
    } catch (error) {
      logger.error({ error }, 'Failed to get learner progress');
      return 'Failed to load progress. Please try again.';
    }
  });

  // ----- test_out_modules -----
  handlers.set('test_out_modules', async (input) => {
    const userId = getUserId();
    if (!userId) return 'You need to be logged in.';

    try {
      const moduleIds = (input.module_ids as string[]).map(id => id.toUpperCase());
      const notes = input.assessment_notes as string || '';

      // Block capstone modules
      const capstones = moduleIds.filter(id => id.startsWith('E'));
      if (capstones.length > 0) {
        return `Cannot test out of capstone modules (${capstones.join(', ')}). Capstones require hands-on assessment.`;
      }

      // Validate all modules exist
      const allModules = await certDb.getModules();
      const moduleMap = new Map(allModules.map(m => [m.id, m]));
      const invalid = moduleIds.filter(id => !moduleMap.has(id));
      if (invalid.length > 0) {
        return `Unknown modules: ${invalid.join(', ')}. Use list_certification_tracks to see valid IDs.`;
      }

      // Check membership for non-free modules
      const paidModules = moduleIds.filter(id => {
        const mod = moduleMap.get(id);
        return mod && !mod.is_free;
      });
      if (paidModules.length > 0 && !memberContext?.is_member) {
        return `Modules ${paidModules.join(', ')} require membership. Only free modules (A1, A2) can be tested out without membership.`;
      }

      // Test out each module
      const results: string[] = [];
      for (const moduleId of moduleIds) {
        const progress = await certDb.testOutModule(userId, moduleId);
        if (progress.status === 'tested_out') {
          results.push(`- ${moduleId}: tested out`);
        } else {
          results.push(`- ${moduleId}: already completed (kept existing status)`);
        }
      }

      const lines = [
        `Marked ${moduleIds.length} module(s) as tested out:`,
        '',
        ...results,
        '',
        `Assessment notes: ${notes}`,
      ];

      // Check for newly earned credentials
      try {
        const awarded = await certDb.checkAndAwardCredentials(userId);
        if (awarded.length > 0) {
          const creds = await certDb.getCredentials();
          const credMap = new Map(creds.map(c => [c.id, c]));
          lines.push('');
          for (const credId of awarded) {
            const cred = credMap.get(credId);
            if (cred) {
              lines.push(`**Credential earned: ${cred.name}!**`);
            }
          }
        }
      } catch (credError) {
        logger.error({ error: credError }, 'Failed to check credential eligibility after test-out');
      }

      return lines.join('\n');
    } catch (error) {
      logger.error({ error }, 'Failed to test out modules');
      return 'Failed to record test-out. Please try again.';
    }
  });

  // ----- start_certification_exam -----
  handlers.set('start_certification_exam', async (input) => {
    const userId = getUserId();
    if (!userId) return 'You need to be logged in to take a specialist capstone.';

    try {
      const moduleId = (input.module_id as string).toUpperCase();

      // Validate it's a capstone module
      const mod = await certDb.getModule(moduleId);
      if (!mod || mod.format !== 'capstone') {
        return `"${moduleId}" is not a capstone module. Valid capstones: E1 (Media Buy), E2 (Creative), E3 (Signals), E4 (Governance).`;
      }

      if (!memberContext?.is_member) {
        return 'Specialist capstones require AgenticAdvertising.org membership.';
      }

      // Check that they hold the Practitioner credential
      const userCredentials = await certDb.getUserCredentials(userId);
      const hasPractitioner = userCredentials.some(c => c.credential_id === 'practitioner');
      if (!hasPractitioner) {
        return 'You need the AdCP Practitioner credential before starting a specialist capstone. Complete foundations (A1-A3) plus any specialization track (B, C, or D) to earn it.';
      }

      // Check prerequisites
      const prereqs = await certDb.checkPrerequisites(userId, moduleId);
      if (!prereqs.met) {
        return `You need to complete these modules first: ${prereqs.missing.join(', ')}`;
      }

      // Check for existing active attempt
      const active = await certDb.getActiveAttempt(userId, mod.track_id);
      if (active) {
        return `You already have an active capstone attempt (started ${new Date(active.started_at).toLocaleDateString()}). Continue the capstone.\n\nAttempt ID: ${active.id}`;
      }

      // Start the module and create an attempt
      await certDb.startModule(userId, moduleId);
      const attempt = await certDb.createAttempt(userId, mod.track_id);

      const criteria = mod.assessment_criteria as certDb.AssessmentCriteria | null;
      const lessonPlan = mod.lesson_plan as certDb.LessonPlan | null;
      const exercises = mod.exercise_definitions as certDb.ExerciseDefinition[] | null;

      // Map module ID to credential
      const credentialMap: Record<string, string> = {
        'E1': 'AdCP Specialist — Media buy',
        'E2': 'AdCP Specialist — Creative',
        'E3': 'AdCP Specialist — Signals',
        'E4': 'AdCP Specialist — Governance',
      };

      const lines = [
        `# Specialist capstone: ${mod.title}`,
        '',
        `Attempt ID: ${attempt.id}`,
        `Credential: **${credentialMap[moduleId] || mod.title}**`,
        '',
        mod.description || '',
        '',
      ];

      // Learning objectives
      if (lessonPlan?.objectives?.length) {
        lines.push('## Objectives');
        lessonPlan.objectives.forEach(o => lines.push(`- ${o}`));
        lines.push('');
      }

      // Key concepts
      if (lessonPlan?.key_concepts?.length) {
        lines.push('## Key concepts');
        lessonPlan.key_concepts.forEach(kc => {
          lines.push(`### ${kc.topic}`);
          lines.push(kc.explanation);
          lines.push('');
        });
      }

      // Lab exercises
      if (exercises?.length) {
        lines.push('## Lab exercises');
        for (const ex of exercises) {
          lines.push(`### ${ex.title}`);
          lines.push(ex.description);
          lines.push('**Steps**:');
          ex.sandbox_actions.forEach(a => lines.push(`- Use \`${a.tool}\`: ${a.guidance}`));
          lines.push('**Success criteria**:');
          ex.success_criteria.forEach(sc => lines.push(`- ${sc}`));
          lines.push('');
        }
      }

      // Assessment criteria with rubrics
      lines.push('## Assessment dimensions');
      (criteria?.dimensions || []).forEach(d => {
        lines.push(`- **${d.name}** (${d.weight}%): ${d.description}`);
        if (d.scoring_guide && Object.keys(d.scoring_guide).length > 0) {
          if (d.scoring_guide.high) lines.push(`  - High (80-100): ${d.scoring_guide.high}`);
          if (d.scoring_guide.medium) lines.push(`  - Medium (50-79): ${d.scoring_guide.medium}`);
          if (d.scoring_guide.low) lines.push(`  - Low (0-49): ${d.scoring_guide.low}`);
        }
      });
      lines.push('');
      lines.push(`**Passing threshold**: ${criteria?.passing_threshold || 70}% in each dimension and overall`);
      lines.push('');

      // Teaching instructions
      lines.push('## Instructions');
      lines.push('Conduct this capstone now. It combines a hands-on lab and adaptive exam:');
      lines.push('1. **Lab phase**: Guide the learner through the lab exercises using real AdCP tools against sandbox agents. Monitor their competence as they work.');
      lines.push('2. **Exam phase**: Ask 6-10 follow-up questions covering assessment dimensions. Adjust difficulty based on responses.');
      lines.push('3. Use the Socratic method throughout — ask probing questions rather than lecturing.');
      lines.push('4. Score honestly against the rubric — do not inflate scores to be encouraging.');
      lines.push('');
      lines.push(`After completing both phases, use complete_certification_exam with attempt_id "${attempt.id}" and your assessed scores.`);

      return lines.join('\n');
    } catch (error) {
      logger.error({ error }, 'Failed to start specialist capstone');
      return 'Failed to start capstone. Please try again.';
    }
  });

  // ----- complete_certification_exam -----
  handlers.set('complete_certification_exam', async (input) => {
    const userId = getUserId();
    if (!userId) return 'You need to be logged in.';

    try {
      const attemptId = input.attempt_id as string;
      const scores = input.scores as Record<string, number>;

      if (!attemptId || !scores || typeof scores !== 'object') return 'attempt_id and scores are required.';

      // Validate score values
      const rawScoreValues = Object.values(scores);
      if (rawScoreValues.length === 0 || !rawScoreValues.every(v => typeof v === 'number' && v >= 0 && v <= 100)) {
        return 'All score values must be numbers between 0 and 100.';
      }

      const attempt = await certDb.getAttempt(attemptId);
      if (!attempt) return 'Exam attempt not found.';
      if (attempt.workos_user_id !== userId) return 'This exam attempt belongs to a different user.';
      if (attempt.status !== 'in_progress') return 'This exam attempt is already completed.';

      const scoreValues = Object.values(scores);
      const overallScore = Math.round(scoreValues.reduce((a, b) => a + b, 0) / scoreValues.length);
      const allAboveThreshold = scoreValues.every(s => s >= 70);
      const passing = allAboveThreshold && overallScore >= 70;

      await certDb.completeAttempt(attemptId, scores, overallScore, passing);

      const lines: string[] = [];

      if (passing) {
        lines.push('# Congratulations! You passed!');
        lines.push('');
        lines.push(`**Overall score**: ${overallScore}%`);
        lines.push('');
        lines.push('**Dimension scores**:');
        Object.entries(scores).forEach(([dim, score]) => {
          lines.push(`- ${dim.replace(/_/g, ' ')}: ${score}%`);
        });

        // Find the capstone module that was being completed and mark it done
        const trackModules = await certDb.getModulesForTrack(attempt.track_id);
        const capstoneMod = trackModules.find(m => m.format === 'capstone');
        if (capstoneMod) {
          await certDb.completeModule(userId, capstoneMod.id, scores);
        }

        // Auto-award credentials (including specialist)
        try {
          const awarded = await certDb.checkAndAwardCredentials(userId);
          if (awarded.length > 0) {
            const creds = await certDb.getCredentials();
            const credMap = new Map(creds.map(c => [c.id, c]));

            for (const credId of awarded) {
              const cred = credMap.get(credId);
              if (cred) {
                lines.push('');
                lines.push(`**Credential earned: ${cred.name}!**`);
                const issued = await issueCertifierBadge(userId, credId, cred, memberContext, {
                  'custom.score': String(overallScore),
                });
                if (issued) {
                  lines.push('Your digital credential has been issued and emailed to you. You can share it on LinkedIn.');
                }
              }
            }
          }
        } catch (credError) {
          logger.error({ error: credError }, 'Failed to check credential eligibility');
        }

        lines.push('');
        lines.push('Welcome to the next generation of advertising technology.');
      } else {
        lines.push('# Capstone results');
        lines.push('');
        lines.push(`**Overall score**: ${overallScore}% (70% required)`);
        lines.push('');
        lines.push('**Dimension scores**:');
        Object.entries(scores).forEach(([dim, score]) => {
          const passed = score >= 70;
          lines.push(`- ${dim.replace(/_/g, ' ')}: ${score}% ${passed ? '' : '(below threshold)'}`);
        });
        lines.push('');
        lines.push('You didn\'t pass this time, but you can retake the capstone after reviewing the areas below threshold. Focus on the protocol concepts that need strengthening and try again when you\'re ready.');
      }

      return lines.join('\n');
    } catch (error) {
      logger.error({ error }, 'Failed to complete capstone');
      return 'Failed to record capstone results. Please try again.';
    }
  });

  return handlers;
}
