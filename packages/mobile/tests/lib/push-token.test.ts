import { isValidExpoPushToken } from '@/lib/push-token';

describe('isValidExpoPushToken (mobile mirror)', () => {
  it('accepts Expo/Exponent push token shapes', () => {
    expect(isValidExpoPushToken('ExpoPushToken[abc]')).toBe(true);
    expect(isValidExpoPushToken('ExponentPushToken[abc-1_2]')).toBe(true);
  });
  it('rejects junk and empty brackets', () => {
    expect(isValidExpoPushToken('nope')).toBe(false);
    expect(isValidExpoPushToken('ExpoPushToken[]')).toBe(false);
  });
});
