/**
 * Tests for Addie Home module
 *
 * Tests the pure functions: cache and slack-renderer
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { HomeContentCache } from '../../server/src/addie/home/cache.js';
import { renderHomeView, renderErrorView } from '../../server/src/addie/home/slack-renderer.js';
import type { HomeContent, AlertSection, QuickAction, ActivityItem, UserStats, AdminPanel } from '../../server/src/addie/home/types.js';

describe('HomeContentCache', () => {
  let cache: HomeContentCache;

  beforeEach(() => {
    cache = new HomeContentCache({ ttlMs: 1000, maxSize: 10 });
  });

  it('returns null for missing entries', () => {
    expect(cache.get('nonexistent')).toBeNull();
  });

  it('stores and retrieves content', () => {
    const content = createMockHomeContent();
    cache.set('user1', content);
    expect(cache.get('user1')).toBe(content);
  });

  it('invalidates single user cache', () => {
    const content = createMockHomeContent();
    cache.set('user1', content);
    cache.set('user2', content);

    cache.invalidate('user1');

    expect(cache.get('user1')).toBeNull();
    expect(cache.get('user2')).toBe(content);
  });

  it('clears all cache entries', () => {
    const content = createMockHomeContent();
    cache.set('user1', content);
    cache.set('user2', content);

    cache.clear();

    expect(cache.get('user1')).toBeNull();
    expect(cache.get('user2')).toBeNull();
  });

  it('evicts oldest entry when at capacity', () => {
    const smallCache = new HomeContentCache({ ttlMs: 1000, maxSize: 2 });
    const content1 = createMockHomeContent();
    const content2 = createMockHomeContent();
    const content3 = createMockHomeContent();

    smallCache.set('user1', content1);
    smallCache.set('user2', content2);
    smallCache.set('user3', content3);

    // user1 should have been evicted
    expect(smallCache.get('user1')).toBeNull();
    expect(smallCache.get('user2')).toBe(content2);
    expect(smallCache.get('user3')).toBe(content3);
  });
});

describe('renderHomeView', () => {
  it('renders basic home view with greeting', () => {
    const content = createMockHomeContent();
    const view = renderHomeView(content);

    expect(view.type).toBe('home');
    expect(Array.isArray(view.blocks)).toBe(true);
    expect(view.blocks.length).toBeGreaterThan(0);

    // First block should be the greeting
    const greeting = view.blocks[0];
    expect(greeting.type).toBe('section');
    expect(greeting.text.text).toContain('Welcome back');
    expect(greeting.text.text).toContain('Test User');
  });

  it('renders alerts when present', () => {
    const content = createMockHomeContent();
    content.alerts = [
      {
        id: 'test-alert',
        severity: 'warning',
        title: 'Test Alert',
        message: 'This is a test alert',
        actionLabel: 'Fix It',
        actionUrl: 'https://example.com',
      },
    ];

    const view = renderHomeView(content);
    const alertBlock = view.blocks.find(
      (b: { type: string; text?: { text: string } }) =>
        b.type === 'section' && b.text?.text?.includes('Test Alert')
    );

    expect(alertBlock).toBeDefined();
    expect(alertBlock.text.text).toContain(':warning:');
    expect(alertBlock.accessory?.type).toBe('button');
    expect(alertBlock.accessory?.url).toBe('https://example.com');
  });

  it('renders quick actions with primary button', () => {
    const content = createMockHomeContent();
    content.quickActions = [
      {
        id: 'ask',
        label: 'Ask Addie',
        actionId: 'addie_home_ask_addie',
        style: 'primary',
      },
      {
        id: 'profile',
        label: 'Update Profile',
        actionId: 'addie_home_update_profile',
      },
    ];

    const view = renderHomeView(content);
    const actionsBlock = view.blocks.find(
      (b: { type: string }) => b.type === 'actions'
    );

    expect(actionsBlock).toBeDefined();
    expect(actionsBlock.elements.length).toBe(2);
    expect(actionsBlock.elements[0].style).toBe('primary');
    expect(actionsBlock.elements[1].style).toBeUndefined();
  });

  it('renders activity feed with events', () => {
    const content = createMockHomeContent();
    content.activity = [
      {
        id: 'event-1',
        type: 'event',
        title: 'Quarterly Meetup',
        description: 'Tomorrow - San Francisco',
        timestamp: new Date(),
        url: 'https://lu.ma/event',
      },
    ];

    const view = renderHomeView(content);
    const activityBlock = view.blocks.find(
      (b: { type: string; elements?: Array<{ text: string }> }) =>
        b.type === 'context' && b.elements?.[0]?.text?.includes('Quarterly Meetup')
    );

    expect(activityBlock).toBeDefined();
    expect(activityBlock.elements[0].text).toContain(':calendar:');
    expect(activityBlock.elements[0].text).toContain('lu.ma/event');
  });

  it('renders stats for active members', () => {
    const content = createMockHomeContent();
    content.stats = {
      memberSince: new Date('2024-01-01'),
      workingGroupCount: 3,
      slackActivity: {
        messages30d: 42,
        activeDays30d: 15,
      },
      subscriptionStatus: 'active',
      renewalDate: new Date('2025-01-01'),
    };

    const view = renderHomeView(content);
    const statsBlock = view.blocks.find(
      (b: { type: string; fields?: unknown[] }) =>
        b.type === 'section' && Array.isArray(b.fields)
    );

    expect(statsBlock).toBeDefined();
    expect(statsBlock.fields.length).toBeGreaterThan(0);
  });

  it('renders admin panel for admins', () => {
    const content = createMockHomeContent();
    content.adminPanel = {
      flaggedThreadCount: 5,
      insightGoals: [
        { goalName: 'Use Cases', current: 10, target: 50 },
      ],
    };

    const view = renderHomeView(content);
    const headerBlock = view.blocks.find(
      (b: { type: string; text?: { text: string } }) =>
        b.type === 'header' && b.text?.text === 'Admin Panel'
    );

    expect(headerBlock).toBeDefined();

    const flaggedBlock = view.blocks.find(
      (b: { type: string; text?: { text: string } }) =>
        b.type === 'section' && b.text?.text?.includes('flagged conversation')
    );
    expect(flaggedBlock).toBeDefined();
    expect(flaggedBlock.text.text).toContain('5');
  });

  it('renders footer with timestamp', () => {
    const content = createMockHomeContent();
    const view = renderHomeView(content);

    const footer = view.blocks[view.blocks.length - 1];
    expect(footer.type).toBe('context');
    expect(footer.elements[0].text).toContain('Last updated');
    expect(footer.elements[1].text).toContain('Open Dashboard');
  });
});

describe('renderErrorView', () => {
  it('renders error message with refresh button', () => {
    const view = renderErrorView('Something went wrong');

    expect(view.type).toBe('home');
    expect(view.blocks.length).toBe(2);

    const errorSection = view.blocks[0];
    expect(errorSection.type).toBe('section');
    expect(errorSection.text.text).toContain('Something went wrong');
    expect(errorSection.text.text).toContain(':warning:');

    const actions = view.blocks[1];
    expect(actions.type).toBe('actions');
    expect(actions.elements[0].action_id).toBe('addie_home_refresh');
  });
});

// Helper to create mock content
function createMockHomeContent(): HomeContent {
  return {
    greeting: {
      userName: 'Test User',
      orgName: 'Test Org',
      isMember: true,
      isLinked: true,
    },
    alerts: [],
    quickActions: [],
    activity: [],
    stats: null,
    adminPanel: null,
    lastUpdated: new Date(),
  };
}
