import { describe, it, expect } from 'vitest';
import { isMultiPartyThread, isDirectedAtAddie, isAddressedToAnotherUser, buildThreadStyleHint } from '../../src/addie/thread-utils.js';

const BOT_ID = 'UBOT123';
const BRIAN = 'UBRIAN';
const CHRISTINA = 'UCHRISTINA';
const ALICE = 'UALICE';

describe('isMultiPartyThread', () => {
  it('returns false with only the bot in the thread', () => {
    const messages = [{ user: BOT_ID, ts: '1' }];
    expect(isMultiPartyThread(messages, BOT_ID, BRIAN)).toBe(false);
  });

  it('returns false with one human and the bot', () => {
    const messages = [
      { user: BOT_ID, ts: '1' },
      { user: BRIAN, ts: '2' },
    ];
    expect(isMultiPartyThread(messages, BOT_ID, BRIAN)).toBe(false);
  });

  it('returns true when a second human has posted', () => {
    const messages = [
      { user: BOT_ID, ts: '1' },
      { user: BRIAN, ts: '2' },
      { user: ALICE, ts: '3' },
    ];
    expect(isMultiPartyThread(messages, BOT_ID, BRIAN)).toBe(true);
  });

  it('counts currentUserId even before their message appears in history', () => {
    // Race condition: current sender not yet in fetched history
    const messages = [{ user: BOT_ID, ts: '1' }, { user: ALICE, ts: '2' }];
    expect(isMultiPartyThread(messages, BOT_ID, BRIAN)).toBe(true);
  });
});

describe('isDirectedAtAddie', () => {
  const thread = [{ user: BOT_ID, ts: '1' }];

  it('returns true when message mentions "addie" by name', () => {
    expect(isDirectedAtAddie('Addie, what do you think?', thread, '2', BRIAN, BOT_ID)).toBe(true);
  });

  it('returns false when message starts with @other_user mention', () => {
    const msg = `<@${CHRISTINA}> know anything about this?`;
    expect(isDirectedAtAddie(msg, thread, '2', BRIAN, BOT_ID)).toBe(false);
  });

  it('returns true when the sender is continuing their own conversation with Addie', () => {
    const threadWithBrian = [
      { user: BOT_ID, ts: '1' },
      { user: BRIAN, ts: '2' },
    ];
    expect(isDirectedAtAddie('what about this?', threadWithBrian, '3', BRIAN, BOT_ID)).toBe(true);
  });

  it('returns false when last human in thread is a different person', () => {
    const threadWithAlice = [
      { user: BOT_ID, ts: '1' },
      { user: BRIAN, ts: '2' },
      { user: ALICE, ts: '3' },
    ];
    expect(isDirectedAtAddie('sounds good', threadWithAlice, '4', BRIAN, BOT_ID)).toBe(false);
  });

  it('returns false when sender sends consecutive messages after another human spoke', () => {
    // Brian and Alice talking — Addie participated earlier but Brian is now
    // sending follow-ups to Alice, not Addie.
    const thread = [
      { user: ALICE, ts: '1' },      // Alice asks
      { user: BOT_ID, ts: '2' },     // Addie responds
      { user: ALICE, ts: '3' },      // Alice follows up
      { user: BOT_ID, ts: '4' },     // Addie responds
      { user: ALICE, ts: '5' },      // Alice says "all good"
      { user: BOT_ID, ts: '6' },     // Addie says bye
      { user: BRIAN, ts: '7' },      // Brian to Alice
      { user: ALICE, ts: '8' },      // Alice to Brian
      { user: BRIAN, ts: '9' },      // Brian to Alice
    ];
    // Brian's follow-up — Alice spoke between his messages, so not directed at Addie
    expect(isDirectedAtAddie('want to have him email me?', thread, '10', BRIAN, BOT_ID)).toBe(false);
  });

  it('returns true when sender follows up after Addie responded', () => {
    const thread = [
      { user: BRIAN, ts: '1' },
      { user: BOT_ID, ts: '2' },     // Addie responded to Brian
    ];
    // Brian follows up after Addie's response
    expect(isDirectedAtAddie('what about the other thing?', thread, '3', BRIAN, BOT_ID)).toBe(true);
  });

  it('returns false when only the sender has spoken (no Addie response)', () => {
    const thread = [
      { user: BRIAN, ts: '1' },
      { user: BRIAN, ts: '2' },
    ];
    expect(isDirectedAtAddie('hello?', thread, '3', BRIAN, BOT_ID)).toBe(false);
  });
});

describe('buildThreadStyleHint', () => {
  it('returns null when no human messages exist', () => {
    const messages = [
      { user: BOT_ID, text: 'Hello!' },
    ];
    expect(buildThreadStyleHint(messages, BOT_ID)).toBeNull();
  });

  it('returns a hint when even one human wrote a short reply', () => {
    const messages = [
      { user: BOT_ID, text: 'Here is a long explanation about how things work in the protocol...' },
      { user: BRIAN, text: 'Yes — the auction happens in GAM, not upstream.' },
    ];
    const hint = buildThreadStyleHint(messages, BOT_ID);
    expect(hint).not.toBeNull();
    expect(hint).toContain('Thread Calibration');
  });

  it('returns a hint when humans write short messages', () => {
    const messages = [
      { user: BRIAN, text: 'AdCP creates buys on programmatic platforms if they accept creative + budget + targeting.' },
      { user: ALICE, text: 'So it competes in the GAM auction like everything else?' },
      { user: BRIAN, text: 'Yes, exactly. The auction happens in GAM.' },
      { user: BOT_ID, text: 'This is a very long response from Addie that goes on and on with lots of detail and background and context and explanation and more detail and even more context and then some disclaimers and then a closing statement and then more context.' },
    ];
    const hint = buildThreadStyleHint(messages, BOT_ID);
    expect(hint).not.toBeNull();
    expect(hint).toContain('Thread Calibration');
    expect(hint).toContain('lead with the answer');
  });

  it('returns null when humans write long messages', () => {
    const longText = 'A'.repeat(500);
    const messages = [
      { user: BRIAN, text: longText },
      { user: ALICE, text: longText },
    ];
    expect(buildThreadStyleHint(messages, BOT_ID)).toBeNull();
  });

  it('fires when mixed short and long messages average under threshold', () => {
    // [100, 500] → true median = 300, under 400 → hint fires
    const messages = [
      { user: BRIAN, text: 'A'.repeat(100) },
      { user: ALICE, text: 'A'.repeat(500) },
    ];
    const hint = buildThreadStyleHint(messages, BOT_ID);
    expect(hint).not.toBeNull();
  });

  it('returns null when median is exactly at the boundary (401 chars)', () => {
    const messages = [
      { user: BRIAN, text: 'A'.repeat(401) },
      { user: ALICE, text: 'A'.repeat(401) },
    ];
    expect(buildThreadStyleHint(messages, BOT_ID)).toBeNull();
  });

  it('fires at exactly 400 chars median', () => {
    const messages = [
      { user: BRIAN, text: 'A'.repeat(400) },
      { user: ALICE, text: 'A'.repeat(400) },
    ];
    const hint = buildThreadStyleHint(messages, BOT_ID);
    expect(hint).not.toBeNull();
  });

  it('includes the median length in the hint', () => {
    const messages = [
      { user: BRIAN, text: 'A'.repeat(80) },
      { user: ALICE, text: 'A'.repeat(120) },
    ];
    const hint = buildThreadStyleHint(messages, BOT_ID);
    expect(hint).toContain('~100-character');
  });

  it('ignores bot messages in length calculation', () => {
    const messages = [
      { user: BOT_ID, text: 'A'.repeat(1000) },
      { user: BRIAN, text: 'Short reply one.' },
      { user: ALICE, text: 'Short reply two.' },
    ];
    const hint = buildThreadStyleHint(messages, BOT_ID);
    expect(hint).not.toBeNull();
  });
});

describe('isAddressedToAnotherUser', () => {
  it('returns true when message starts with a @mention of another user', () => {
    expect(isAddressedToAnotherUser(`<@${CHRISTINA}> know anything about this?`, BOT_ID)).toBe(true);
  });

  it('returns false when message starts with @bot mention', () => {
    expect(isAddressedToAnotherUser(`<@${BOT_ID}> can you help?`, BOT_ID)).toBe(false);
  });

  it('returns false for plain text messages', () => {
    expect(isAddressedToAnotherUser('what do you think about this?', BOT_ID)).toBe(false);
  });

  it('returns false when @mention appears mid-message not at start', () => {
    expect(isAddressedToAnotherUser(`good point, cc <@${CHRISTINA}>`, BOT_ID)).toBe(false);
  });
});
