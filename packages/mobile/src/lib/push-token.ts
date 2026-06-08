// Mirror of packages/api/src/lib/push-token.ts — keep the regex in sync so the
// client never sends a token the API rejects (api/mobile share no package).
export const EXPO_PUSH_TOKEN_RE = /^Expo(nent)?PushToken\[[^\]]+\]$/;

export function isValidExpoPushToken(value: string): boolean {
  return EXPO_PUSH_TOKEN_RE.test(value);
}
