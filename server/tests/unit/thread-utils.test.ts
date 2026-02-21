import { describe, it, expect } from 'vitest';
import { isMultiPartyThread, isDirectedAtAddie, isAddressedToAnotherUser } from '../../src/addie/thread-utils.js';

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
