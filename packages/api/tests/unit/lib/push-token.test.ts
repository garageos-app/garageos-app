import { describe, expect, it } from 'vitest';

import { EXPO_PUSH_TOKEN_RE, isValidExpoPushToken } from '../../../src/lib/push-token.js';

describe('isValidExpoPushToken', () => {
  it('accepts ExponentPushToken[...] and ExpoPushToken[...]', () => {
    expect(isValidExpoPushToken('ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]')).toBe(true);
    expect(isValidExpoPushToken('ExpoPushToken[abc-123_DEF]')).toBe(true);
  });

  it('rejects junk, empty brackets, and FCM/APNs raw tokens', () => {
    expect(isValidExpoPushToken('not-a-token')).toBe(false);
    expect(isValidExpoPushToken('ExpoPushToken[]')).toBe(false);
    expect(isValidExpoPushToken('')).toBe(false);
    expect(isValidExpoPushToken('fcm:APA91bH...')).toBe(false);
  });

  it('exposes the regex for reuse in Zod schemas', () => {
    expect(EXPO_PUSH_TOKEN_RE.test('ExpoPushToken[a]')).toBe(true);
  });
});
