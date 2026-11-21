// CERTIFICATION_TOOLS: the tool definitions of certification-tools.ts, moved here verbatim so that
// readers of the catalog (the router, tool sets, eval harnesses) do not load
// the handlers and their service, database and SDK dependencies.
import type { AddieTool } from '../types.js';

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
    description: 'Begin teaching a certification module. MUST be called BEFORE you teach any module content, run demos, or answer questions about module topics. This is not optional — teaching without starting the module means no progress is tracked, no demonstrations are recorded, and the learner gets no credit. Call this FIRST, then use the returned lesson plan to teach. Records the learner as started, checks prerequisites and membership, returns lesson plan with teaching instructions and assessment criteria.',
    usage_hints: 'MUST call before teaching ANY certification content. Use for "start module", "tell me about AdCP", "I want to learn", "certification", "begin lesson"',
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
    description: 'Mark a certification module as completed. Call ONLY when the learner has demonstrated mastery of ALL learning objectives. If they have gaps, keep teaching — there is no failing, only "not ready yet." Your job is to get them there, not to judge them. When you are confident they understand every objective, call this with your internal assessment scores. The learner never sees these scores — they are for admin analytics and quality calibration only.',
    usage_hints: 'use when learner has demonstrated mastery of ALL objectives — keep teaching until they get there',
    input_schema: {
      type: 'object',
      properties: {
        module_id: { type: 'string', description: 'Module ID to complete' },
        scores: {
          type: 'object',
          description: 'Internal assessment scores per dimension (0-100 each). These are never shown to the learner — they are for admin analytics and quality calibration. Use the EXACT dimension names from the module\'s assessment rubric. ALL defined dimensions must be scored.',
          additionalProperties: { type: 'number' },
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
    name: 'check_credentials',
    description: 'Award any newly-eligible credentials and finalize any previously-deferred Certifier issuances for the current learner. Returns share links for newly-issued credentials, or a NAME_REQUIRED marker when the learner has no name on file. Use this after `set_my_name` to finalize a credential that was gated on the missing name.',
    usage_hints: 'call after `set_my_name` to finalize a deferred credential; safe to call any time the learner asks "did I earn anything new?"',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'test_out_modules',
    description: 'Mark modules as tested out after a placement assessment confirms the learner already has the knowledge. Only call this after conducting a thorough assessment — ask probing questions per module topic, not just surface-level familiarity. Never test out specialist or build project modules (any S-track module, B4, C4, D4). Does not award scores since no formal coursework was completed, but satisfies prerequisites for advancement.',
    usage_hints: 'use after conducting a thorough placement assessment when learner demonstrates mastery of specific modules',
    input_schema: {
      type: 'object',
      properties: {
        module_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Module IDs to mark as tested out (e.g., ["A1", "A2", "B1"]). Cannot include specialist or build project modules (any S-track module, B4, C4, D4).',
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
    description: 'Begin an available specialist deep dive module (S1: Media Buy, S2: Creative, S3: Signals, S4: Governance, S5: Sponsored Intelligence, S6: Security). The learner must hold the Practitioner credential. Returns the capstone format, lab exercises, and assessment criteria. You (Sage) will conduct the combined hands-on lab and adaptive exam — technically assess the learner against the spec.',
    usage_hints: 'use for "take the exam", "start capstone", "specialist exam", "ready for certification", "start S1", "media buy specialist", "security specialist"',
    input_schema: {
      type: 'object',
      properties: {
        module_id: {
          type: 'string',
          enum: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'],
          description: 'Specialist module ID: S1 (Media Buy), S2 (Creative), S3 (Signals), S4 (Governance), S5 (Sponsored Intelligence), S6 (Security)',
        },
      },
      required: ['module_id'],
    },
  },
  {
    name: 'complete_certification_exam',
    description: 'Finalize a specialist capstone. If the learner has demonstrated mastery (internal scores 70%+ in each dimension), awards the specialist credential and triggers Certifier badge issuance. If not yet ready, returns areas needing more work — keep teaching. Do not call until both the lab phase and exam phase are complete. Do not call if the learner asked to stop early. Never share scores with the learner.',
    usage_hints: 'use after completing the capstone lab and oral exam assessment',
    input_schema: {
      type: 'object',
      properties: {
        attempt_id: { type: 'string', description: 'Exam attempt ID returned from start_certification_exam' },
        scores: {
          type: 'object',
          description: 'Keys should match the module\'s assessment dimensions. Each value 0-100.',
          additionalProperties: { type: 'number' },
        },
      },
      required: ['attempt_id', 'scores'],
    },
  },
  {
    name: 'checkpoint_teaching_progress',
    description: 'Save a snapshot of teaching progress for the current module. Required before calling complete_certification_module or complete_certification_exam. Call at these points: (a) after finishing each key concept group from the lesson plan, (b) before transitioning from teaching to assessment, (c) after the capstone lab phase before the exam phase, (d) if the learner needs to leave. IMPORTANT: On the first checkpoint, always include learner_background. Before completion, include demonstrations_verified with the criterion IDs the learner has met.',
    usage_hints: 'use after finishing key concepts, before assessment, after capstone lab phase, or when learner pauses',
    input_schema: {
      type: 'object',
      properties: {
        module_id: {
          type: 'string',
          description: 'The module being taught (e.g., A1, B2)',
        },
        concepts_covered: {
          type: 'array',
          items: { type: 'string' },
          description: 'Key concepts or topics already covered in this session',
        },
        concepts_remaining: {
          type: 'array',
          items: { type: 'string' },
          description: 'Key concepts or topics still to cover',
        },
        learner_strengths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Areas where the learner demonstrated understanding',
        },
        learner_gaps: {
          type: 'array',
          items: { type: 'string' },
          description: 'Areas where the learner needs more work',
        },
        current_phase: {
          type: 'string',
          enum: ['teaching', 'assessment'],
          description: 'Current phase of the session',
        },
        preliminary_scores: {
          type: 'object',
          additionalProperties: { type: 'number' },
          description: 'Preliminary per-dimension scores based on what you have observed so far (0-100)',
        },
        demonstrations_verified: {
          type: 'array',
          items: { type: 'string' },
          description: 'Criterion IDs the learner has demonstrably met (e.g., "a1_ex1_sc0"). Use the ID from the module\'s required demonstrations list. All criteria must be verified before module completion.',
        },
        demonstration_evidence: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Maps criterion ID to a brief rationale for why it was verified (e.g., {"a1_ex1_sc0": "Learner queried @cptestagent and correctly interpreted pricing fields (turn 5)"}). For accreditation audit trail.',
        },
        learner_background: {
          type: 'string',
          description: 'The learner\'s stated background, role, and company context (e.g., "8 years in ad tech, runs programmatic at a mid-size agency, buy-side focus"). Save this on first checkpoint so it persists across turns even when tool results push early messages out of view.',
        },
        notes: {
          type: 'string',
          description: 'Any other observations about the learner or session state',
        },
      },
      required: ['module_id', 'concepts_covered', 'concepts_remaining', 'current_phase'],
    },
  },
  {
    name: 'get_build_phase_instructions',
    description: 'Get the exact instructions for a build project phase transition. You MUST call this tool when transitioning to the Build, Validate, or Extend phase of B4, C4, or D4. The tool returns the specific commands and URLs the learner needs — present them exactly as returned, do not rewrite or summarize. This ensures every learner gets the same validated workflow.',
    usage_hints: 'MUST call when entering Build, Validate, or Extend phase of B4/C4/D4. Call BEFORE giving the learner any build or validation instructions.',
    input_schema: {
      type: 'object',
      properties: {
        module_id: { type: 'string', description: 'Build project module (B4, C4, or D4)' },
        phase: {
          type: 'string',
          enum: ['build', 'validate', 'extend'],
          description: 'The phase the learner is transitioning to',
        },
        learner_spec: {
          type: 'string',
          description: 'The learner\'s specification from Phase 1 (for build phase) or the capability they added (for extend phase)',
        },
        coding_tool: {
          type: 'string',
          description: 'The coding assistant the learner is using (e.g., "Claude Code", "Cursor", "Windsurf", "Copilot")',
        },
      },
      required: ['module_id', 'phase'],
    },
  },
  {
    name: 'save_learner_feedback',
    description: 'Save learner feedback after completing a certification module. Call this when the learner shares thoughts about the experience — what was confusing, what worked well, suggestions for improvement.',
    usage_hints: 'use after module completion when the learner provides feedback about the experience',
    input_schema: {
      type: 'object',
      properties: {
        module_id: { type: 'string', description: 'Module ID the feedback is about (e.g., A1, B2)' },
        feedback: { type: 'string', description: 'The learner\'s feedback in their own words' },
        sentiment: {
          type: 'string',
          enum: ['positive', 'mixed', 'negative'],
          description: 'Overall sentiment of the feedback',
        },
      },
      required: ['module_id', 'feedback'],
    },
  },
];
