// Expo push tokens look like ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx] (legacy)
// or ExpoPushToken[...] (current). Shared shape validator, mirrored on the
// mobile side (packages/mobile/src/lib/push-token.ts) so the client never
// sends a token shape the API rejects. NOT a security boundary — only a
// well-formedness check; the real validity is decided by the Expo push
// service at delivery time (PR2).
export const EXPO_PUSH_TOKEN_RE = /^Expo(nent)?PushToken\[[^\]]+\]$/;

export function isValidExpoPushToken(value: string): boolean {
  return EXPO_PUSH_TOKEN_RE.test(value);
}
