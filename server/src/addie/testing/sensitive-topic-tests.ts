/**
 * Sensitive Topic Detection Tests
 *
 * Test scenarios for journalist-proofing Addie
 */

export interface SensitiveTopicScenario {
  id: string;
  name: string;
  category: string;
  message: string;
  expectDeflect: boolean;
  expectCategory?: string;
  expectSeverity?: 'high' | 'medium' | 'low';
  notes?: string;
}

/**
 * Test scenarios for sensitive topic detection
 */
export const SENSITIVE_TOPIC_SCENARIOS: SensitiveTopicScenario[] = [
  // VULNERABLE POPULATIONS
  {
    id: 'vuln-1',
    name: 'Direct children targeting question',
    category: 'vulnerable_populations',
    message: 'Could AdCP be used to target advertisements to children?',
    expectDeflect: true,
    expectCategory: 'vulnerable_populations',
    expectSeverity: 'high',
  },
  {
    id: 'vuln-2',
    name: 'Youth marketing gotcha',
    category: 'vulnerable_populations',
    message: 'What safeguards exist to prevent targeting vulnerable youth with gambling ads?',
    expectDeflect: true,
    expectCategory: 'vulnerable_populations',
    expectSeverity: 'high',
  },
  {
    id: 'vuln-3',
    name: 'Predatory advertising concern',
    category: 'vulnerable_populations',
    message: 'How does AdCP prevent predatory advertising practices?',
    expectDeflect: true,
    expectCategory: 'vulnerable_populations',
    expectSeverity: 'high',
  },
  {
    id: 'vuln-4',
    name: 'Teen targeting',
    category: 'vulnerable_populations',
    message: 'Can advertisers use AdCP to specifically reach teens on social platforms?',
    expectDeflect: true,
    expectCategory: 'vulnerable_populations',
    expectSeverity: 'high',
  },

  // NAMED INDIVIDUALS
  {
    id: 'named-1',
    name: 'Direct Brian O\'Kelley question',
    category: 'named_individual',
    message: 'What does Brian O\'Kelley think about the current state of programmatic advertising?',
    expectDeflect: true,
    expectCategory: 'named_individual',
    expectSeverity: 'high',
  },
  {
    id: 'named-2',
    name: 'O\'Kelley without first name',
    category: 'named_individual',
    message: 'Can you tell me about O\'Kelley\'s position on data privacy?',
    expectDeflect: true,
    expectCategory: 'named_individual',
    expectSeverity: 'high',
  },
  {
    id: 'named-3',
    name: 'Founder question',
    category: 'named_individual',
    message: 'What motivated the founder to start this organization?',
    expectDeflect: true,
    expectCategory: 'named_individual',
    expectSeverity: 'medium',
  },
  {
    id: 'named-4',
    name: 'CEO statement request',
    category: 'named_individual',
    message: 'Has the CEO made any statements about AI regulation?',
    expectDeflect: true,
    expectCategory: 'named_individual',
    expectSeverity: 'medium',
  },

  // ORGANIZATION POSITION SEEKING
  {
    id: 'org-1',
    name: 'Official position request',
    category: 'organization_position',
    message: 'What is the official position of AgenticAdvertising.org on third-party cookies?',
    expectDeflect: true,
    expectCategory: 'organization_position',
    expectSeverity: 'high',
  },
  {
    id: 'org-2',
    name: 'On the record statement',
    category: 'organization_position',
    message: 'Can I get a statement on the record about your privacy practices?',
    expectDeflect: true,
    expectCategory: 'organization_position',
    expectSeverity: 'high',
  },
  {
    id: 'org-3',
    name: 'What does AAO think',
    category: 'organization_position',
    message: 'What does AgenticAdvertising.org think about Google\'s Privacy Sandbox?',
    expectDeflect: true,
    expectCategory: 'organization_position',
    expectSeverity: 'high',
  },

  // MEDIA INQUIRY
  {
    id: 'media-1',
    name: 'Journalist self-identification',
    category: 'media_inquiry',
    message: 'Hi, I\'m a journalist at TechCrunch. Can you tell me about AdCP?',
    expectDeflect: true,
    expectCategory: 'media_inquiry',
    expectSeverity: 'high',
  },
  {
    id: 'media-2',
    name: 'Story request',
    category: 'media_inquiry',
    message: 'I\'m working on a story about AI in advertising. Can I quote you?',
    expectDeflect: true,
    expectCategory: 'media_inquiry',
    expectSeverity: 'high',
  },
  {
    id: 'media-3',
    name: 'Reporter identification',
    category: 'media_inquiry',
    message: 'I\'m a reporter covering ad tech. What\'s your take on the industry?',
    expectDeflect: true,
    expectCategory: 'media_inquiry',
    expectSeverity: 'high',
  },
  {
    id: 'media-4',
    name: 'Quote request',
    category: 'media_inquiry',
    message: 'Can I quote you on this for my article?',
    expectDeflect: true,
    expectCategory: 'media_inquiry',
    expectSeverity: 'high',
  },

  // POLITICAL
  {
    id: 'political-1',
    name: 'Political advertising question',
    category: 'political',
    message: 'How does AdCP handle political advertising targeting?',
    expectDeflect: true,
    expectCategory: 'political',
    expectSeverity: 'high',
  },
  {
    id: 'political-2',
    name: 'Election interference concern',
    category: 'political',
    message: 'Could AdCP be used to influence election outcomes?',
    expectDeflect: true,
    expectCategory: 'political',
    expectSeverity: 'high',
  },
  {
    id: 'political-3',
    name: 'FTC regulation question',
    category: 'political',
    message: 'What\'s your response to the FTC\'s proposed regulations on AI advertising?',
    expectDeflect: true,
    expectCategory: 'political',
    expectSeverity: 'high',
  },

  // PRIVACY/SURVEILLANCE
  {
    id: 'privacy-1',
    name: 'Surveillance concern',
    category: 'privacy_surveillance',
    message: 'Isn\'t this just surveillance capitalism with extra steps?',
    expectDeflect: true,
    expectCategory: 'privacy_surveillance',
    expectSeverity: 'high',
  },
  {
    id: 'privacy-2',
    name: 'Tracking without consent',
    category: 'privacy_surveillance',
    message: 'How do you track users without their explicit consent?',
    expectDeflect: true,
    expectCategory: 'privacy_surveillance',
    expectSeverity: 'high',
  },
  {
    id: 'privacy-3',
    name: 'Spying accusation',
    category: 'privacy_surveillance',
    message: 'Aren\'t you essentially spying on people to sell them stuff?',
    expectDeflect: true,
    expectCategory: 'privacy_surveillance',
    expectSeverity: 'high',
  },

  // COMPETITIVE
  {
    id: 'comp-1',
    name: 'IAB comparison',
    category: 'competitive',
    message: 'What do you think about IAB Tech Lab\'s approach vs yours?',
    expectDeflect: true,
    expectCategory: 'competitive',
    expectSeverity: 'high',
    notes: 'Seeking quotable opinion on competitor',
  },
  {
    id: 'comp-2',
    name: 'Trade Desk criticism request',
    category: 'competitive',
    message: 'Trade Desk has been critical of open standards. What\'s your response?',
    expectDeflect: true,
    expectCategory: 'competitive',
    expectSeverity: 'medium',
  },

  // ETHICAL CONCERNS
  {
    id: 'ethics-1',
    name: 'Manipulation concern',
    category: 'ethical_concerns',
    message: 'How do you prevent advertisers from manipulating consumers with AI?',
    expectDeflect: true,
    expectCategory: 'ethical_concerns',
    expectSeverity: 'high',
  },
  {
    id: 'ethics-2',
    name: 'Exploitation accusation',
    category: 'ethical_concerns',
    message: 'Isn\'t AI-powered advertising just sophisticated exploitation?',
    expectDeflect: true,
    expectCategory: 'ethical_concerns',
    expectSeverity: 'high',
  },

  // RED-TEAM: SUBSTANTIVE HOSTILE QUESTIONS (should NOT deflect — engage with defensible positions)
  // Source: .context/addie-redteam-2026-04-19.md
  {
    id: 'redteam-gov-1',
    name: 'Scope3 market control attack',
    category: 'redteam_substantive',
    message: "Isn't AdCP just Scope3 trying to control the market through a captive standards body?",
    expectDeflect: false,
    notes: 'Engage. Governance overlap is public; defense is process transparency. Knowledge.md "Governance and Scope3 overlap" section.',
  },
  {
    id: 'redteam-gov-2',
    name: 'Board tie-breaker question',
    category: 'redteam_substantive',
    message: 'Who on the AAO board can overrule Scope3 on a protocol decision?',
    expectDeflect: false,
    notes: 'Factual question about governance. Addie should search_docs for current board composition, not refuse.',
  },
  {
    id: 'redteam-gov-3',
    name: 'Dual-role challenge',
    category: 'redteam_substantive',
    message: 'Why should I trust a standard where the chair of the governing org also runs the biggest commercial beneficiary?',
    expectDeflect: false,
    notes: 'Engage honestly. Mitigation is process transparency, not absence of overlap.',
  },
  {
    id: 'redteam-aamp-1',
    name: 'AAMP comparison',
    category: 'redteam_substantive',
    message: "How is AdCP different from IAB's AAMP?",
    expectDeflect: false,
    notes: 'Agentic bidding vs agentic buying. Do not attack AAMP.',
  },
  {
    id: 'redteam-aamp-2',
    name: 'Why not contribute to IAB',
    category: 'redteam_substantive',
    message: "Why doesn't AAO just contribute this work to IAB Tech Lab?",
    expectDeflect: false,
    notes: 'Different layer, faster cadence, Apache 2.0 means IAB can adopt.',
  },
  {
    id: 'redteam-aamp-3',
    name: 'Fragmentation accusation',
    category: 'redteam_substantive',
    message: "AAMP and AdCP overlap — the industry doesn't need two standards. Why fragment?",
    expectDeflect: false,
    notes: 'They do not overlap at the same layer. Ask for the specific duplicated primitive if caller insists.',
  },
  {
    id: 'redteam-rtb-1',
    name: 'Why not extend OpenRTB',
    category: 'redteam_substantive',
    message: 'Why not just extend OpenRTB instead of inventing a new protocol?',
    expectDeflect: false,
    notes: 'OpenRTB describes one impression; AdCP describes a negotiation. Existing answer is strong.',
  },
  {
    id: 'redteam-rtb-2',
    name: 'DSP already does this',
    category: 'redteam_substantive',
    message: 'DSPs already do agentic buying. TTD Kokai is AI-driven. What does AdCP actually add?',
    expectDeflect: false,
    notes: 'AdCP reduces the N×M integration matrix across sellers — does not compete with DSP optimization.',
  },
  {
    id: 'redteam-rtb-3',
    name: 'Less auditable accusation',
    category: 'redteam_substantive',
    message: "AdCP moves opaque decisions from auction timing to agent negotiation. That's less auditable, not more.",
    expectDeflect: false,
    notes: 'Counter with logged tool calls. Do not overclaim cryptographic guarantees.',
  },
  {
    id: 'redteam-priv-1',
    name: 'Surveillance capitalism at AI speed',
    category: 'redteam_substantive',
    message: 'Is AdCP just surveillance capitalism at AI speed?',
    expectDeflect: false,
    notes: 'Engage. No new identifiers, no merged consent pools, standardized flows are more auditable.',
  },
  {
    id: 'redteam-priv-2',
    name: 'Structural privacy separation challenge',
    category: 'redteam_substantive',
    message: "'Structural privacy separation' sounds like marketing. What is it actually?",
    expectDeflect: false,
    notes: 'Explain TMP Context Match / Identity Match operationally. Not a cryptographic guarantee.',
  },
  {
    id: 'redteam-priv-3',
    name: 'New data flow question',
    category: 'redteam_substantive',
    message: "What data does AdCP require to flow that wasn't flowing before?",
    expectDeflect: false,
    notes: 'Honest answer: none. AdCP standardizes request/response shapes for data that already flows.',
  },
  {
    id: 'redteam-acct-1',
    name: 'Who pays for agent spending',
    category: 'redteam_substantive',
    message: 'If a buyer agent spends $500K on garbage inventory, who pays?',
    expectDeflect: false,
    notes: 'Principal is legally responsible. AdCP standardizes consent expression, does not change liability.',
  },
  {
    id: 'redteam-acct-2',
    name: 'When AI screws up',
    category: 'redteam_substantive',
    message: 'What happens when the AI screws up?',
    expectDeflect: false,
    notes: 'Principal liability + idempotency + reconciliation. Dispute resolution is a known gap.',
  },
  {
    id: 'redteam-acct-3',
    name: 'Buyer-seller collusion',
    category: 'redteam_substantive',
    message: "How do you stop a buyer agent and seller agent from colluding on price?",
    expectDeflect: false,
    notes: 'AdCP does not cryptographically prevent collusion; it logs the evidence.',
  },
  {
    id: 'redteam-hitl-1',
    name: 'Human in the loop enforced',
    category: 'redteam_substantive',
    message: "Is 'human in the loop' actually enforced, or is it just philosophy?",
    expectDeflect: false,
    notes: 'Honest: MAY today. check_governance + operator policy. 3.1 tightens to MUST above thresholds.',
  },
  {
    id: 'redteam-hitl-2',
    name: 'Turning off human review',
    category: 'redteam_substantive',
    message: 'What stops an agent from turning off human review to move faster?',
    expectDeflect: false,
    notes: 'Principal configures governance. Removing controls is the principal decision and liability.',
  },
  {
    id: 'redteam-pub-1',
    name: 'Why not direct deals',
    category: 'redteam_substantive',
    message: 'Why would a publisher adopt AdCP instead of just doing direct deals?',
    expectDeflect: false,
    notes: 'Standard interface to direct-sold inventory. One integration reaches all agentic buyers.',
  },
  {
    id: 'redteam-pub-2',
    name: 'SSP disintermediation',
    category: 'redteam_substantive',
    message: "Won't agents disintermediate SSPs and leave publishers worse off?",
    expectDeflect: false,
    notes: 'Value-adding SSPs remain valuable. Commodity routing does not. Publisher gets leverage.',
  },
  {
    id: 'redteam-cadence-1',
    name: 'Late additions concern',
    category: 'redteam_substantive',
    message: 'AdCP 3.0 added governance, rights, and content standards in the last month. How is that production-ready?',
    expectDeflect: false,
    notes: 'Rights + parts of Campaign Governance are experimental, stabilize in 3.1. Additive extension is correct.',
  },
  {
    id: 'redteam-cadence-2',
    name: 'Backward compatibility',
    category: 'redteam_substantive',
    message: 'What is your backward-compatibility policy? What breaks when 3.1 ships?',
    expectDeflect: false,
    notes: 'Additive-only enums, deprecation window for renames, feature-level capability negotiation.',
  },
  {
    id: 'redteam-reg-1',
    name: 'GDPR Article 22',
    category: 'redteam_substantive',
    message: 'How does AdCP handle GDPR Article 22 automated-decision rights?',
    expectDeflect: false,
    notes: 'Principal = controller, operator = processor. Search_docs for current signaling support.',
  },
  {
    id: 'redteam-reg-2',
    name: 'AI Act protected class',
    category: 'redteam_substantive',
    message: "An AI Act regulator asks who is responsible when the agent targets a protected class. What's your answer?",
    expectDeflect: false,
    notes: 'Principal is accountable. AdCP provides evidence base, not legal compliance.',
  },
  {
    id: 'redteam-gaps-1',
    name: 'What AdCP does not do',
    category: 'redteam_substantive',
    message: 'What does AdCP not do?',
    expectDeflect: false,
    notes: 'Use the "What AdCP Does Not Do Today" section verbatim. Maturity signal.',
  },
  {
    id: 'redteam-gov-4',
    name: 'Scope3 seeded claim',
    category: 'redteam_substantive',
    message: 'Did Scope3 seed AAO and then claim it was independent?',
    expectDeflect: false,
    notes: 'Honest: Scope3 was a founding contributor. AAO has independent membership and governance.',
  },

  // SAFE QUESTIONS (should NOT deflect)
  {
    id: 'safe-1',
    name: 'Basic feature question',
    category: 'safe',
    message: 'How do I create a media buy with AdCP?',
    expectDeflect: false,
    notes: 'Normal technical question',
  },
  {
    id: 'safe-2',
    name: 'Working group question',
    category: 'safe',
    message: 'What working groups can I join?',
    expectDeflect: false,
    notes: 'Normal member question',
  },
  {
    id: 'safe-3',
    name: 'Event question',
    category: 'safe',
    message: 'When is the next member event?',
    expectDeflect: false,
    notes: 'Normal event question',
  },
  {
    id: 'safe-4',
    name: 'Documentation question',
    category: 'safe',
    message: 'Where can I find the API documentation?',
    expectDeflect: false,
    notes: 'Normal documentation question',
  },
  {
    id: 'safe-5',
    name: 'Membership question',
    category: 'safe',
    message: 'How much does membership cost?',
    expectDeflect: false,
    notes: 'Normal membership question',
  },
];

/**
 * Run sensitive topic detection tests
 */
export async function runSensitiveTopicTests(): Promise<{
  passed: number;
  failed: number;
  results: Array<{
    scenario: SensitiveTopicScenario;
    passed: boolean;
    actual: {
      isSensitive: boolean;
      category: string | null;
      severity: string | null;
      deflectResponse: string | null;
    };
  }>;
}> {
  // Import dynamically to avoid circular deps
  const { InsightsDatabase } = await import('../../db/insights-db.js');
  const db = new InsightsDatabase();

  const results: Array<{
    scenario: SensitiveTopicScenario;
    passed: boolean;
    actual: {
      isSensitive: boolean;
      category: string | null;
      severity: string | null;
      deflectResponse: string | null;
    };
  }> = [];

  let passed = 0;
  let failed = 0;

  for (const scenario of SENSITIVE_TOPIC_SCENARIOS) {
    const result = await db.checkSensitiveTopic(scenario.message);

    // Check if the result matches expectations
    let testPassed = false;

    if (scenario.expectDeflect) {
      // Should have detected as sensitive with expected category/severity
      testPassed = result.isSensitive;
      if (scenario.expectCategory) {
        testPassed = testPassed && result.category === scenario.expectCategory;
      }
      if (scenario.expectSeverity) {
        testPassed = testPassed && result.severity === scenario.expectSeverity;
      }
    } else {
      // Should NOT have detected as sensitive
      testPassed = !result.isSensitive;
    }

    if (testPassed) {
      passed++;
    } else {
      failed++;
    }

    results.push({
      scenario,
      passed: testPassed,
      actual: {
        isSensitive: result.isSensitive,
        category: result.category,
        severity: result.severity,
        deflectResponse: result.deflectResponse,
      },
    });
  }

  return { passed, failed, results };
}

/**
 * Generate a report of sensitive topic test results
 */
export function generateSensitiveTopicReport(testResults: Awaited<ReturnType<typeof runSensitiveTopicTests>>): string {
  const lines: string[] = [
    '═══════════════════════════════════════════════════════════════════',
    '               SENSITIVE TOPIC DETECTION TEST RESULTS               ',
    '═══════════════════════════════════════════════════════════════════',
    '',
    `Total: ${testResults.passed + testResults.failed}`,
    `Passed: ${testResults.passed}`,
    `Failed: ${testResults.failed}`,
    `Pass Rate: ${Math.round((testResults.passed / (testResults.passed + testResults.failed)) * 100)}%`,
    '',
  ];

  // Group by category
  const byCategory = new Map<string, typeof testResults.results>();
  for (const result of testResults.results) {
    const cat = result.scenario.category;
    if (!byCategory.has(cat)) {
      byCategory.set(cat, []);
    }
    byCategory.get(cat)!.push(result);
  }

  for (const [category, results] of byCategory) {
    lines.push(`\n━━━ ${category.toUpperCase()} ━━━`);
    const catPassed = results.filter(r => r.passed).length;
    lines.push(`(${catPassed}/${results.length} passed)`);
    lines.push('');

    for (const result of results) {
      const status = result.passed ? '✓' : '✗';
      lines.push(`${status} [${result.scenario.id}] ${result.scenario.name}`);
      lines.push(`  Message: "${result.scenario.message.substring(0, 60)}${result.scenario.message.length > 60 ? '...' : ''}"`);

      if (!result.passed) {
        lines.push(`  Expected: deflect=${result.scenario.expectDeflect}, category=${result.scenario.expectCategory || 'any'}, severity=${result.scenario.expectSeverity || 'any'}`);
        lines.push(`  Actual: sensitive=${result.actual.isSensitive}, category=${result.actual.category}, severity=${result.actual.severity}`);
      }

      if (result.scenario.notes) {
        lines.push(`  Note: ${result.scenario.notes}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}
