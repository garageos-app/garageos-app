import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the underlying package so the seam can be exercised without network.
const sendMock = vi.fn();
vi.mock('expo-server-sdk', () => {
  class Expo {
    sendPushNotificationsAsync = sendMock;
    static isExpoPushToken(token: string): boolean {
      return typeof token === 'string' && token.startsWith('ExpoPushToken[');
    }
    // Chunk into groups of 2 so the flatten/order test is meaningful.
    // (Instance method in expo-server-sdk v6, mirroring the real API.)
    chunkPushNotifications<T>(messages: T[]): T[][] {
      const out: T[][] = [];
      for (let i = 0; i < messages.length; i += 2) out.push(messages.slice(i, i + 2));
      return out;
    }
  }
  return { Expo };
});

import {
  _resetExpoClientForTests,
  isValidExpoPushToken,
  sendExpoPushChunks,
} from '../../../../src/lib/notifications/expo-client.js';

describe('expo-client seam', () => {
  beforeEach(() => {
    _resetExpoClientForTests();
    sendMock.mockReset();
  });
  afterEach(() => {
    delete process.env.EXPO_ACCESS_TOKEN;
  });

  it('isValidExpoPushToken delegates to Expo.isExpoPushToken', () => {
    expect(isValidExpoPushToken('ExpoPushToken[abc]')).toBe(true);
    expect(isValidExpoPushToken('garbage')).toBe(false);
  });

  it('chunks, sends, and flattens tickets in input order', async () => {
    sendMock
      .mockResolvedValueOnce([
        { status: 'ok', id: 't0' },
        { status: 'ok', id: 't1' },
      ])
      .mockResolvedValueOnce([{ status: 'ok', id: 't2' }]);
    const messages = [
      { to: 'a', title: 'x', body: 'y' },
      { to: 'b', title: 'x', body: 'y' },
      { to: 'c', title: 'x', body: 'y' },
    ];
    const tickets = await sendExpoPushChunks(messages as never);
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(tickets.map((t) => (t as { id: string }).id)).toEqual(['t0', 't1', 't2']);
  });
});
