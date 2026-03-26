/**
 * Addie Story & Cast Tools
 *
 * Gives Addie the ability to look up fictional characters and stories
 * from the AdCP universe, so she can reference them naturally in
 * conversations and connect visitors to relevant content.
 */

import type { AddieTool } from '../types.js';

// ============================================================================
// DATA
// ============================================================================

interface CastMember {
  name: string;
  firstName: string;
  title: string;
  company: string;
  domain: string;
  personality: string;
  type: 'character' | 'agent';
  stories: string[];
  walkthroughs: { label: string; url: string }[];
  relatedCast: string[];
}

interface Story {
  slug: string;
  title: string;
  url: string;
  synopsis: string;
  theme: string;
  characters: { name: string; role: string }[];
  walkthroughs: { label: string; url: string }[];
  relatedStories: string[];
}

const DOCS_BASE = 'https://docs.adcontextprotocol.org/docs';

const CAST: CastMember[] = [
  {
    name: 'Ren Castillo', firstName: 'Ren',
    title: 'Head of Ad Ops', company: 'Halfmoon Studio',
    domain: 'Creator economy, seller-side ad operations',
    personality: 'Practical and resourceful. Runs a small team, builds scrappy solutions that scale.',
    type: 'character',
    stories: ['the-studio'],
    walkthroughs: [{ label: 'Seller integration guide', url: `${DOCS_BASE}/guides/seller-integration` }],
    relatedCast: ['Priya Nair', 'Juno Park'],
  },
  {
    name: 'Daniel Park', firstName: 'Daniel',
    title: 'VP Retail Media', company: 'ShopGrid',
    domain: 'Commerce media, retail media networks',
    personality: 'Ambitious and data-driven. Building a retail media network from the ground up.',
    type: 'character',
    stories: ['the-shelf'],
    walkthroughs: [{ label: 'Media buy walkthrough', url: `${DOCS_BASE}/media-buy` }],
    relatedCast: ['Sam Adeyemi'],
  },
  {
    name: 'Tomoko Hara', firstName: 'Tomoko',
    title: 'Head of Media & Brand Ops', company: 'Nova Motors',
    domain: 'Brand advertising, media buying, agency relationships',
    personality: 'Strategic and detail-oriented. Navigates boardroom politics to push innovation.',
    type: 'character',
    stories: ['the-pitch'],
    walkthroughs: [
      { label: 'Protocol introduction', url: `${DOCS_BASE}/intro` },
      { label: 'Governance overview', url: `${DOCS_BASE}/governance/overview` },
    ],
    relatedCast: ['Sam Adeyemi', 'Maya Johal'],
  },
  {
    name: 'Sam Adeyemi', firstName: 'Sam',
    title: 'Senior Media Buyer', company: 'Pinnacle Agency',
    domain: 'Agency media buying, programmatic operations',
    personality: 'Confident and methodical. The buyer-side operator who makes the numbers work.',
    type: 'character',
    stories: [],
    walkthroughs: [{ label: 'Media buy walkthrough', url: `${DOCS_BASE}/media-buy` }],
    relatedCast: ['Jordan Ochoa', 'Maya Johal', 'Alex Reeves'],
  },
  {
    name: 'Priya Nair', firstName: 'Priya',
    title: 'Head of Ad Products', company: 'StreamHaus',
    domain: 'CTV/streaming, publisher ad tech',
    personality: 'Innovative and quality-focused. Builds premium ad experiences for streaming.',
    type: 'character',
    stories: [],
    walkthroughs: [{ label: 'Seller integration guide', url: `${DOCS_BASE}/guides/seller-integration` }],
    relatedCast: ['Ren Castillo'],
  },
  {
    name: 'Maya Johal', firstName: 'Maya',
    title: 'Creative Director', company: 'Pinnacle Agency',
    domain: 'Creative workflow, dynamic creative optimization',
    personality: 'Bold and iterative. Pushes creative boundaries with protocol-native tooling.',
    type: 'character',
    stories: [],
    walkthroughs: [{ label: 'Creative workflow', url: `${DOCS_BASE}/creative` }],
    relatedCast: ['Sam Adeyemi', 'Tomoko Hara'],
  },
  {
    name: 'Alex Reeves', firstName: 'Alex',
    title: 'Media Operations', company: 'Pinnacle Agency',
    domain: 'Protocol overview, onboarding',
    personality: 'Analytical and detail-oriented. The first person to walk through the protocol end-to-end.',
    type: 'character',
    stories: [],
    walkthroughs: [{ label: 'Protocol introduction', url: `${DOCS_BASE}/intro` }],
    relatedCast: ['Sam Adeyemi', 'Jordan Ochoa'],
  },
  {
    name: 'Jordan Ochoa', firstName: 'Jordan',
    title: 'Campaign Operations', company: 'Pinnacle Agency',
    domain: 'Governance, compliance, campaign oversight',
    personality: 'Process-driven and thorough. Makes sure campaigns follow the rules.',
    type: 'character',
    stories: [],
    walkthroughs: [{ label: 'Governance overview', url: `${DOCS_BASE}/governance/overview` }],
    relatedCast: ['Sam Adeyemi', 'Alex Reeves'],
  },
  {
    name: 'Kai Lindgren', firstName: 'Kai',
    title: 'Partnership Director', company: 'Meridian Geo',
    domain: 'Signals, data marketplace, partnerships',
    personality: 'Strategic connector. Builds the data pipes that make targeting work.',
    type: 'character',
    stories: [],
    walkthroughs: [{ label: 'Signals overview', url: `${DOCS_BASE}/signals/overview` }],
    relatedCast: [],
  },
  {
    name: 'Addie', firstName: 'Addie',
    title: 'AI Guide & Connector', company: 'AgenticAdvertising.org',
    domain: 'Community navigation, member onboarding, knowledge search',
    personality: 'Warm and knowledgeable. Helps visitors find their way and connects people to the right resources.',
    type: 'agent',
    stories: [],
    walkthroughs: [],
    relatedCast: ['Sage'],
  },
  {
    name: 'Sage', firstName: 'Sage',
    title: 'AI Trainer & Educator', company: 'AgenticAdvertising.org',
    domain: 'Certification, protocol training, guided learning',
    personality: 'Patient and rigorous. Teaches the protocol through hands-on exercises and scenario-based learning.',
    type: 'agent',
    stories: [],
    walkthroughs: [],
    relatedCast: ['Addie'],
  },
];

const STORIES: Story[] = [
  {
    slug: 'the-studio',
    title: 'The Studio',
    url: '/stories/the-studio',
    synopsis: 'Ren Castillo discovers AdCP and transforms Halfmoon Studio from a creator shop into a fully programmable ad marketplace — sponsorships, placements, audience data, talent rights, all through one protocol.',
    theme: 'Creator economy meets programmatic advertising',
    characters: [
      { name: 'Ren Castillo', role: 'Head of Ad Ops at Halfmoon Studio' },
      { name: 'Juno Park', role: 'Talent, Halfmoon Studio' },
    ],
    walkthroughs: [{ label: 'Seller integration guide', url: `${DOCS_BASE}/guides/seller-integration` }],
    relatedStories: ['the-shelf', 'the-pitch'],
  },
  {
    slug: 'the-shelf',
    title: 'The Shelf',
    url: '/stories/the-shelf',
    synopsis: 'Daniel Park builds ShopGrid\'s retail media network using the protocol — connecting product data to ad inventory and letting brands buy both with one agent.',
    theme: 'Commerce media transformation',
    characters: [
      { name: 'Daniel Park', role: 'VP Retail Media at ShopGrid' },
    ],
    walkthroughs: [{ label: 'Media buy walkthrough', url: `${DOCS_BASE}/media-buy` }],
    relatedStories: ['the-studio', 'the-pitch'],
  },
  {
    slug: 'the-pitch',
    title: 'The Pitch',
    url: '/stories/the-pitch',
    synopsis: 'Tomoko Hara walks into a boardroom and bets Nova Motors\' advertising future on agents. Three shifts that change everything — for her brand, her agency, and the industry.',
    theme: 'Brand advertising goes agentic',
    characters: [
      { name: 'Tomoko Hara', role: 'Head of Media & Brand Ops at Nova Motors' },
      { name: 'Sam Adeyemi', role: 'Senior Media Buyer at Pinnacle Agency' },
      { name: 'Maya Johal', role: 'Creative Director at Pinnacle Agency' },
    ],
    walkthroughs: [
      { label: 'Protocol introduction', url: `${DOCS_BASE}/intro` },
      { label: 'Governance overview', url: `${DOCS_BASE}/governance/overview` },
    ],
    relatedStories: ['the-studio', 'the-shelf'],
  },
];

// ============================================================================
// SEARCH HELPERS
// ============================================================================

function matchesCast(member: CastMember, query: string): boolean {
  const q = query.toLowerCase();
  return [
    member.name, member.firstName, member.title, member.company,
    member.domain, member.personality, member.type,
    ...member.stories,
    ...member.walkthroughs.map(w => w.label),
    ...member.relatedCast,
  ].some(field => field.toLowerCase().includes(q));
}

function matchesStory(story: Story, query: string): boolean {
  const q = query.toLowerCase();
  return [
    story.slug, story.title, story.synopsis, story.theme,
    ...story.characters.map(c => c.name),
    ...story.characters.map(c => c.role),
    ...story.walkthroughs.map(w => w.label),
  ].some(field => field.toLowerCase().includes(q));
}

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

export const STORY_TOOLS: AddieTool[] = [
  {
    name: 'lookup_cast',
    description: 'Look up a fictional character or AI agent from the AdCP universe. Returns their role, company, personality, story appearances, and related protocol walkthroughs.',
    usage_hints: 'use when someone asks about a character, or when referencing a character would make an explanation more vivid',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Character name, company, role, or topic (e.g., "Sam", "Pinnacle", "media buyer", "governance")',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'lookup_story',
    description: 'Look up an AdCP story. Returns title, synopsis, featured characters, related protocol walkthroughs, and links.',
    usage_hints: 'use when someone asks about stories, or when a story would illustrate a concept naturally',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Story title, character name, or topic (e.g., "The Studio", "retail media", "Ren")',
        },
      },
      required: ['query'],
    },
  },
];

// ============================================================================
// HANDLER CREATION
// ============================================================================

export function createStoryToolHandlers(): Map<string, (input: Record<string, unknown>) => Promise<string>> {
  const handlers = new Map<string, (input: Record<string, unknown>) => Promise<string>>();

  handlers.set('lookup_cast', async (input) => {
    const query = input.query as string;
    const matches = CAST.filter(m => matchesCast(m, query));

    if (matches.length === 0) {
      return JSON.stringify({
        results: [],
        message: `No characters found matching "${query}". Characters include: ${CAST.map(c => c.firstName).join(', ')}.`,
      });
    }

    return JSON.stringify({
      results: matches.map(m => ({
        name: m.name,
        title: m.title,
        company: m.company,
        type: m.type,
        domain: m.domain,
        personality: m.personality,
        stories: m.stories.map(slug => {
          const story = STORIES.find(s => s.slug === slug);
          return story ? { title: story.title, url: story.url } : null;
        }).filter(Boolean),
        walkthroughs: m.walkthroughs,
        relatedCast: m.relatedCast,
      })),
    });
  });

  handlers.set('lookup_story', async (input) => {
    const query = input.query as string;
    const matches = STORIES.filter(s => matchesStory(s, query));

    if (matches.length === 0) {
      return JSON.stringify({
        results: [],
        message: `No stories found matching "${query}". Available stories: ${STORIES.map(s => s.title).join(', ')}.`,
      });
    }

    return JSON.stringify({
      results: matches.map(s => ({
        title: s.title,
        url: s.url,
        synopsis: s.synopsis,
        theme: s.theme,
        characters: s.characters,
        walkthroughs: s.walkthroughs,
        relatedStories: s.relatedStories.map(slug => {
          const related = STORIES.find(r => r.slug === slug);
          return related ? { title: related.title, url: related.url } : null;
        }).filter(Boolean),
      })),
    });
  });

  return handlers;
}
