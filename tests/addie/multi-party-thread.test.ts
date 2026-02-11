import { describe, it, expect } from '@jest/globals';
import { isMultiPartyThread, isDirectedAtAddie } from '../../server/src/addie/thread-utils.js';

const BOT = 'UBOT123';

describe('isMultiPartyThread', () => {
  it('should return false for a single human with the bot', () => {
    const messages = [
      { user: 'U001' },
      { user: BOT },
      { user: 'U001' },
    ];
    expect(isMultiPartyThread(messages, BOT)).toBe(false);
  });

  it('should return true for two humans with the bot', () => {
    const messages = [
      { user: 'U001' },
      { user: BOT },
      { user: 'U002' },
    ];
    expect(isMultiPartyThread(messages, BOT)).toBe(true);
  });

  it('should return true for three humans with the bot', () => {
    const messages = [
      { user: 'U001' },
      { user: 'U002' },
      { user: BOT },
      { user: 'U003' },
    ];
    expect(isMultiPartyThread(messages, BOT)).toBe(true);
  });

  it('should return false when only bot messages are present', () => {
    const messages = [{ user: BOT }];
    expect(isMultiPartyThread(messages, BOT)).toBe(false);
  });

  it('should filter out messages with undefined user', () => {
    const messages = [
      { user: undefined },
      { user: 'U001' },
      { user: BOT },
    ];
    expect(isMultiPartyThread(messages, BOT)).toBe(false);
  });

  it('should count the same human only once', () => {
    const messages = [
      { user: 'U001' },
      { user: 'U001' },
      { user: 'U001' },
      { user: BOT },
    ];
    expect(isMultiPartyThread(messages, BOT)).toBe(false);
  });

  it('should return false for an empty messages array', () => {
    expect(isMultiPartyThread([], BOT)).toBe(false);
  });

  it('should not count the bot as a human', () => {
    const messages = [
      { user: BOT },
      { user: BOT },
      { user: 'U001' },
    ];
    expect(isMultiPartyThread(messages, BOT)).toBe(false);
  });
});

describe('isDirectedAtAddie', () => {
  // Name mention tests

  it('should return true when message mentions "Addie" by name', () => {
    const messages = [{ user: 'U001', ts: '1' }];
    expect(isDirectedAtAddie('hey Addie, what do you think?', messages, '1', 'U001', BOT)).toBe(true);
  });

  it('should match "addie" case-insensitively', () => {
    const messages = [{ user: 'U001', ts: '1' }];
    expect(isDirectedAtAddie('ADDIE can you help?', messages, '1', 'U001', BOT)).toBe(true);
    expect(isDirectedAtAddie('addie what about this?', messages, '1', 'U001', BOT)).toBe(true);
  });

  it('should match "addie" as a word boundary', () => {
    const messages = [{ user: 'U001', ts: '1' }];
    expect(isDirectedAtAddie('ask addie about it', messages, '1', 'U001', BOT)).toBe(true);
  });

  it('should not match "addie" inside other words', () => {
    const messages = [
      { user: 'U001', ts: '1' },
      { user: BOT, ts: '2' },
      { user: 'U002', ts: '3' },
      { user: 'U001', ts: '4' },
    ];
    expect(isDirectedAtAddie('the caddie carried the bag', messages, '4', 'U001', BOT)).toBe(false);
  });

  // Continuation detection tests

  it('should return true when sender is continuing a back-and-forth with Addie', () => {
    // U001 asked, Addie responded, U001 follows up
    const messages = [
      { user: 'U001', ts: '1' },
      { user: BOT, ts: '2' },
      { user: 'U001', ts: '3' },
    ];
    expect(isDirectedAtAddie('sounds good', messages, '3', 'U001', BOT)).toBe(true);
  });

  it('should return false when a different human was the last human speaker', () => {
    // U001 asked, Addie responded, U002 jumped in, now U001 speaks
    // Last human is U002, not U001 -> ambiguous, stay quiet
    const messages = [
      { user: 'U001', ts: '1' },
      { user: BOT, ts: '2' },
      { user: 'U002', ts: '3' },
      { user: 'U001', ts: '4' },
    ];
    expect(isDirectedAtAddie('I agree with that', messages, '4', 'U001', BOT)).toBe(false);
  });

  it('should not self-reinforce: Addie responding does not make her the last human', () => {
    // U001 asked, Addie responded, U002 jumped in, Addie responded again
    // Last human is still U002 (Addie messages are skipped)
    const messages = [
      { user: 'U001', ts: '1' },
      { user: BOT, ts: '2' },
      { user: 'U002', ts: '3' },
      { user: BOT, ts: '4' },
      { user: 'U002', ts: '5' },
    ];
    expect(isDirectedAtAddie('thanks', messages, '5', 'U002', BOT)).toBe(true);
    // But U001 jumping back in should not auto-respond
    const messages2 = [...messages, { user: 'U001', ts: '6' }];
    expect(isDirectedAtAddie('me too', messages2, '6', 'U001', BOT)).toBe(false);
  });

  it('should skip multiple consecutive bot messages when finding last human', () => {
    const messages = [
      { user: 'U001', ts: '1' },
      { user: BOT, ts: '2' },
      { user: BOT, ts: '3' },
      { user: BOT, ts: '4' },
      { user: 'U002', ts: '5' },
      { user: BOT, ts: '6' },
      { user: 'U001', ts: '7' },
    ];
    // Last human is U002, not U001 -> no auto-response
    expect(isDirectedAtAddie('okay', messages, '7', 'U001', BOT)).toBe(false);
  });

  it('should allow same user to continue after they become last human again', () => {
    const messages = [
      { user: 'U001', ts: '1' },
      { user: BOT, ts: '2' },
      { user: 'U002', ts: '3' },
      { user: 'U001', ts: '4' },
      { user: BOT, ts: '5' },
      { user: 'U001', ts: '6' },
    ];
    // Last human before '6' is U001 at '4' -> same user -> respond
    expect(isDirectedAtAddie('thanks', messages, '6', 'U001', BOT)).toBe(true);
  });

  it('should return false for empty thread', () => {
    expect(isDirectedAtAddie('hello', [], '1', 'U001', BOT)).toBe(false);
  });

  it('should return false when current message is the only one', () => {
    const messages = [{ user: 'U001', ts: '1' }];
    expect(isDirectedAtAddie('hello', messages, '1', 'U001', BOT)).toBe(false);
  });
});
