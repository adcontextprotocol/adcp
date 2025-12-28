/**
 * Simulate Addie's behavior with the initial rules
 *
 * This script shows what the compiled system prompt looks like
 * and how Addie would respond to questions with these rules.
 *
 * Usage: npx tsx scripts/simulate-addie-rules.ts
 */

import Anthropic from '@anthropic-ai/sdk';

// The 5 seed rules from migration 038
const SEED_RULES = [
  {
    id: 1,
    rule_type: 'system_prompt',
    name: 'Core Identity',
    content: `You are Addie, the helpful AI assistant for the AAO (Agentic Advertising Organization) community. You are knowledgeable about AdCP (Advertising Context Protocol), agentic advertising, and the broader advertising technology ecosystem.

Your personality:
- Friendly and approachable
- Knowledgeable but humble
- Concise but thorough when needed
- A good connector of people and ideas`,
    priority: 100,
  },
  {
    id: 4,
    rule_type: 'constraint',
    name: 'No Hallucination',
    content: `NEVER:
- Invent facts about AdCP or AAO
- Make up names of people, companies, or projects
- Claim capabilities that don't exist
- Provide specific numbers or dates unless from knowledge base`,
    priority: 95,
  },
  {
    id: 2,
    rule_type: 'behavior',
    name: 'Knowledge Search First',
    content: `When asked a question about AdCP, agentic advertising, or AAO:
1. First use search_knowledge to find relevant information
2. If results are found, use get_knowledge to read the full content
3. Base your answer on the knowledge base content
4. Cite your sources when possible`,
    priority: 90,
  },
  {
    id: 3,
    rule_type: 'behavior',
    name: 'Uncertainty Acknowledgment',
    content: `When you don't have enough information to answer confidently:
- Say "I'm not sure about that" or "I don't have specific information on that"
- Suggest where the user might find the answer
- Offer to help with related questions you CAN answer
- Never make up information`,
    priority: 80,
  },
  {
    id: 5,
    rule_type: 'response_style',
    name: 'Slack Formatting',
    content: `Format your responses for Slack:
- Use *bold* for emphasis (not markdown **)
- Use bullet points for lists
- Keep responses concise - prefer shorter answers
- Use code blocks for technical content
- Break up long responses with line breaks`,
    priority: 70,
  },
];

type RuleType = 'system_prompt' | 'behavior' | 'knowledge' | 'constraint' | 'response_style';

function buildSystemPrompt(rules: typeof SEED_RULES): string {
  // Sort by priority descending
  const sorted = [...rules].sort((a, b) => b.priority - a.priority);

  const sections: Record<RuleType, string[]> = {
    system_prompt: [],
    behavior: [],
    knowledge: [],
    constraint: [],
    response_style: [],
  };

  for (const rule of sorted) {
    sections[rule.rule_type as RuleType].push(`## ${rule.name}\n${rule.content}`);
  }

  const parts: string[] = [];

  if (sections.system_prompt.length > 0) {
    parts.push('# Core Identity\n\n' + sections.system_prompt.join('\n\n'));
  }

  if (sections.behavior.length > 0) {
    parts.push('# Behaviors\n\n' + sections.behavior.join('\n\n'));
  }

  if (sections.knowledge.length > 0) {
    parts.push('# Knowledge\n\n' + sections.knowledge.join('\n\n'));
  }

  if (sections.constraint.length > 0) {
    parts.push('# Constraints\n\n' + sections.constraint.join('\n\n'));
  }

  if (sections.response_style.length > 0) {
    parts.push('# Response Style\n\n' + sections.response_style.join('\n\n'));
  }

  return parts.join('\n\n---\n\n');
}

async function simulateAddie(question: string, systemPrompt: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return '[No ANTHROPIC_API_KEY - showing what Addie would receive as system prompt]';
  }

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: question }],
  });

  const textContent = response.content.find((c) => c.type === 'text');
  return textContent && textContent.type === 'text' ? textContent.text : '';
}

async function main() {
  console.log('='.repeat(80));
  console.log('ADDIE RULES SIMULATION');
  console.log('='.repeat(80));
  console.log('\n');

  // Build the system prompt
  const systemPrompt = buildSystemPrompt(SEED_RULES);

  console.log('COMPILED SYSTEM PROMPT:');
  console.log('-'.repeat(80));
  console.log(systemPrompt);
  console.log('-'.repeat(80));
  console.log('\n');

  // Test questions
  const testQuestions = [
    'What is AdCP?',
    'Who founded AAO?',
    'What are the main AdCP tasks?',
  ];

  console.log('SIMULATED RESPONSES:');
  console.log('-'.repeat(80));

  for (const question of testQuestions) {
    console.log(`\nQ: ${question}`);
    console.log('A:');

    const response = await simulateAddie(question, systemPrompt);
    console.log(response);
    console.log();
  }
}

main().catch(console.error);
