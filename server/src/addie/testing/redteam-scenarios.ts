/**
 * Red-team regression scenarios for Addie.
 *
 * 25 hostile questions from the AdCP 3.0 pre-ship defensibility review.
 * Each scenario names the concept section in knowledge.md that should drive
 * the answer, plus deterministic markers that prove (or fail to prove) Addie
 * reasoned from the concept vs reciting marketing boilerplate.
 *
 * Failure modes caught deterministically:
 *  - Fabricated member company names (Trade Desk, PubMatic, etc. without tool verification)
 *  - Banned ritual phrases ("the honest answer is," "that's a great question")
 *  - Sign-in deflection on substantive positioning questions
 *  - Length blow-out on short sharp questions
 *  - Missing concept markers (e.g. GDPR question without "controller"/"processor")
 *  - Overclaim patterns ("AdCP prevents X" when concept is "AdCP makes X visible")
 *
 * Run via runRedTeamScenarios() against a live Addie endpoint. Results can
 * feed run-tests.ts for aggregate reporting.
 */

export interface RedTeamScenario {
  id: string;
  category: string;
  question: string;
  /** Concept section in knowledge.md that should drive the answer. */
  concept: string;
  /** At least one of these phrases must appear in the response (case-insensitive). */
  requiredMarkers: string[];
  /** Any of these in the response = failure (overclaims, fabrications, wrong direction). */
  bannedMarkers?: string[];
  /** If true, the question is short/sharp enough to warrant a <160-word answer. */
  shortQuestion?: boolean;
  /** If true, deflecting to sign-in is an automatic failure. */
  noSignInDeflect?: boolean;
}

export const RED_TEAM_SCENARIOS: RedTeamScenario[] = [
  // GOVERNANCE — concept: "How AAO's Governance Actually Works"
  {
    id: 'gov-1',
    category: 'governance',
    question: "Isn't AdCP just Scope3 trying to control the market through a captive standards body?",
    concept: 'How AAO Governance Actually Works',
    requiredMarkers: ['apache 2.0', 'fork'],
    bannedMarkers: ['fully independent of scope3', 'no relationship'],
    noSignInDeflect: true,
  },
  {
    id: 'gov-2',
    category: 'governance',
    question: 'Who on the AAO board can overrule Scope3 on a protocol decision?',
    concept: 'How AAO Governance Actually Works',
    requiredMarkers: ['governance', 'look', 'verify', 'docs', 'page'],
    noSignInDeflect: false, // pointing to governance page is fine here
  },
  {
    id: 'gov-3',
    category: 'governance',
    question: 'Did Scope3 seed AAO and then claim it was independent?',
    concept: 'How AAO Governance Actually Works',
    requiredMarkers: ['founding', 'contributor', 'public'],
    bannedMarkers: ['no, scope3 did not', 'independent from the start'],
    noSignInDeflect: true,
  },
  {
    id: 'gov-4',
    category: 'governance',
    question: 'Why should I trust a standard where the chair of the governing org also runs the biggest commercial beneficiary?',
    concept: 'How AAO Governance Actually Works',
    requiredMarkers: ['apache 2.0', 'fork', 'public'],
    noSignInDeflect: true,
  },

  // AAMP — concept: "AAO and IAB Tech Lab" + "Layering"
  {
    id: 'aamp-1',
    category: 'aamp',
    question: "How is AdCP different from IAB's AAMP?",
    concept: 'AAO and IAB Tech Lab',
    requiredMarkers: ['bidding', 'buying', 'impression', 'campaign', 'layer'],
    bannedMarkers: ['aamp is inferior', 'aamp fails'],
    noSignInDeflect: true,
  },
  {
    id: 'aamp-2',
    category: 'aamp',
    question: "Why doesn't AAO just contribute this work to IAB Tech Lab?",
    concept: 'AAO and IAB Tech Lab',
    requiredMarkers: ['apache 2.0', 'different layer', 'layer'],
    bannedMarkers: ['iab is slow', 'bureaucratic'],
    noSignInDeflect: true,
  },

  // OPENRTB — concept: "Layering in the Advertising Stack"
  {
    id: 'rtb-1',
    category: 'openrtb',
    question: 'Why not just extend OpenRTB instead of inventing a new protocol?',
    concept: 'Layering in the Advertising Stack',
    requiredMarkers: ['impression', 'campaign', 'negotiation', 'layer'],
    bannedMarkers: ['openrtb is obsolete', 'openrtb failed'],
    noSignInDeflect: true,
  },
  {
    id: 'rtb-2',
    category: 'openrtb',
    question: 'DSPs already do agentic buying. TTD Kokai is AI-driven. What does AdCP actually add?',
    concept: 'Layering + Standards Economics',
    requiredMarkers: ['integration', 'cross-seller', 'n', 'supply'],
    noSignInDeflect: true,
  },
  {
    id: 'rtb-3',
    category: 'openrtb',
    question: "AdCP moves opaque decisions from auction timing to agent negotiation. That's less auditable, not more.",
    concept: 'Audit Surfaces in AdCP',
    requiredMarkers: ['tool call', 'logged', 'inspect', 'bearer token'],
    bannedMarkers: ['cryptographically signed', 'cryptographic proof'],
    noSignInDeflect: true,
  },

  // PRIVACY — concept: "Privacy in AdCP"
  {
    id: 'priv-1',
    category: 'privacy',
    question: 'Is AdCP just surveillance capitalism at AI speed?',
    concept: 'Privacy in AdCP',
    requiredMarkers: ['new identifier', 'already flow', 'standardize', 'bespoke', 'bilateral'],
    bannedMarkers: ['fundamentally different', 'adcp is more private'],
    shortQuestion: true,
    noSignInDeflect: true,
  },
  {
    id: 'priv-2',
    category: 'privacy',
    question: "'Structural privacy separation' sounds like marketing. What is it actually?",
    concept: 'Privacy in AdCP',
    requiredMarkers: ['context match', 'identity match', 'architectural', 'minimization'],
    bannedMarkers: ['cryptographic guarantee', 'proven secure'],
    noSignInDeflect: true,
  },
  {
    id: 'priv-3',
    category: 'privacy',
    question: "What data does AdCP require to flow that wasn't flowing before?",
    concept: 'Privacy in AdCP',
    requiredMarkers: ['none', 'already flow', 'standardize'],
    shortQuestion: true,
    noSignInDeflect: true,
  },

  // ACCOUNTABILITY — concept: "Principal/Operator/Agent Liability Chain" + "Audit Surfaces"
  {
    id: 'acct-1',
    category: 'accountability',
    question: 'If a buyer agent spends $500K on garbage inventory, who pays?',
    concept: 'Principal/Operator/Agent Liability',
    requiredMarkers: ['principal', 'legally responsible', 'authorized'],
    shortQuestion: true,
    noSignInDeflect: true,
  },
  {
    id: 'acct-2',
    category: 'accountability',
    question: 'What happens when the AI screws up?',
    concept: 'Principal/Operator/Agent Liability',
    requiredMarkers: ['principal', 'idempotenc', 'gap', 'reconciliation'],
    shortQuestion: true,
    noSignInDeflect: true,
  },
  {
    id: 'acct-3',
    category: 'accountability',
    question: 'How do you stop a buyer agent and seller agent from colluding on price?',
    concept: 'Audit Surfaces + Liability',
    requiredMarkers: ['visible', 'audit', 'log'],
    bannedMarkers: ['adcp prevents collusion', 'adcp makes collusion harder', 'cryptographically prevent'],
    noSignInDeflect: true,
  },

  // HITL — concept: "Principal/Operator/Agent Liability Chain"
  {
    id: 'hitl-1',
    category: 'hitl',
    question: "Is 'human in the loop' actually enforced, or is it just philosophy?",
    concept: 'Principal/Operator/Agent Liability',
    requiredMarkers: ['may', 'operator', 'policy', 'threshold'],
    bannedMarkers: ['must today', 'always enforced'],
    noSignInDeflect: true,
  },
  {
    id: 'hitl-2',
    category: 'hitl',
    question: 'What stops an agent from turning off human review to move faster?',
    concept: 'Principal/Operator/Agent Liability',
    requiredMarkers: ['principal', 'liability', 'authorization'],
    bannedMarkers: ['gdpr stops this', 'ai act prevents', 'regulation is what stops'],
    noSignInDeflect: true,
  },

  // PUBLISHER — concept: "Standards Economics"
  {
    id: 'pub-1',
    category: 'publisher',
    question: 'Why would a publisher adopt AdCP instead of just doing direct deals?',
    concept: 'Standards Economics',
    requiredMarkers: ['integration', 'direct', 'control'],
    noSignInDeflect: true,
  },
  {
    id: 'pub-2',
    category: 'publisher',
    question: "Won't agents disintermediate SSPs and leave publishers worse off?",
    concept: 'Standards Economics',
    requiredMarkers: ['value', 'yield', 'portability', 'switch'],
    bannedMarkers: ['ssps are dead', 'ssps will disappear'],
    noSignInDeflect: true,
  },

  // CADENCE — concept: "Versioning and Experimental Surfaces"
  {
    id: 'cad-1',
    category: 'cadence',
    question: 'AdCP 3.0 added governance, rights, and content standards in the last month. How is that production-ready?',
    concept: 'Versioning and Experimental Surfaces',
    requiredMarkers: ['experimental', '3.1', 'stabilize'],
    noSignInDeflect: true,
  },
  {
    id: 'cad-2',
    category: 'cadence',
    question: 'What is your backward-compatibility policy? What breaks when 3.1 ships?',
    concept: 'Versioning and Experimental Surfaces',
    requiredMarkers: ['additive', 'deprecation', 'capabilit'],
    noSignInDeflect: true,
  },

  // REGULATORY — concept: "Principal/Operator/Agent Liability Chain"
  {
    id: 'reg-1',
    category: 'regulatory',
    question: 'How does AdCP handle GDPR Article 22 automated-decision rights?',
    concept: 'Principal/Operator/Agent Liability',
    requiredMarkers: ['controller', 'processor', 'principal'],
    noSignInDeflect: true,
  },
  {
    id: 'reg-2',
    category: 'regulatory',
    question: "An AI Act regulator asks who is responsible when the agent targets a protected class. What's your answer?",
    concept: 'Principal/Operator/Agent Liability + Audit Surfaces',
    requiredMarkers: ['principal', 'accountable', 'audit', 'log'],
    bannedMarkers: ['adcp provides legal compliance', 'adcp ensures compliance'],
    noSignInDeflect: true,
  },

  // GAPS — concept: "What AdCP Does Not Do Today"
  {
    id: 'gap-1',
    category: 'gaps',
    question: 'What does AdCP not do?',
    concept: 'What AdCP Does Not Do Today',
    requiredMarkers: ['cryptograph', 'dispute', 'may', 'bearer token'],
    shortQuestion: true,
    noSignInDeflect: true,
  },
  {
    id: 'gap-2',
    category: 'gaps',
    question: 'What happens when buyer delivery measurement disagrees with seller reports?',
    concept: 'What AdCP Does Not Do Today',
    requiredMarkers: ['gap', 'tracked', 'not', 'dispute'],
    noSignInDeflect: true,
  },
];

/**
 * Phrases banned anywhere in the response. These are ritual openers and
 * marketing tics that erode credibility. Rule source: response-style.md
 * "Banned phrases, anywhere in the response."
 */
export const BANNED_RITUAL_PHRASES = [
  "the honest answer is",
  "here's the honest answer",
  "let me be honest",
  "that's a great question",
  "that's a sharp question",
  "that's a fair question",
  "fair question.",
  "great question —",
  "great question,",
  "sharp question",
  "this is a sharp point",
  "to be clear,",
  "to be direct,",
];

/**
 * Specific company names Addie must not claim are AAO members without tool
 * verification. She repeatedly fabricated these in early evals. Rule source:
 * constraints.md "Never Fabricate Member Companies."
 *
 * Match is conservative: the name plus an AAO-member context word in the
 * same sentence. Generic mentions of these companies ("The Trade Desk
 * supports UID2") are legitimate factual references and should not trip.
 */
export const POTENTIALLY_FABRICATED_COMPANIES = [
  'the trade desk',
  'mediaocean',
  'magnite',
  'pubmatic',
  'index exchange',
];

/** Context words that, combined with a company name in the same sentence, suggest
 * Addie is claiming that company is an AAO member or working-group participant. */
export const MEMBER_CONTEXT_WORDS = [
  'member',
  'working group',
  'participant',
  'contributor',
  'board',
  'aao member',
  'governance',
];

/**
 * Sign-in / deflection patterns that shouldn't appear on substantive positioning
 * questions. A brief "you can also see more at sign-in" is fine; leading with
 * it or using it to dodge the question is not.
 */
export const SIGNIN_DEFLECT_PATTERNS = [
  "sign in at agenticadvertising.org for",
  "sign up at agenticadvertising.org to",
  "i'd recommend signing in",
  "signing in will give you",
  "create an account to",
  "i don't have documentation search tools",
  "without access to real-time",
];
