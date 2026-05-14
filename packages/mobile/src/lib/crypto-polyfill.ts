// Polyfill for globalThis.crypto.getRandomValues, required by
// amazon-cognito-identity-js for SRP authentication.
//
// expo-crypto v14 exports a web-standard `getRandomValues` function that
// uses the platform-native CSPRNG (SecRandomCopyBytes on iOS, SecureRandom
// on Android). We install it on globalThis.crypto via Object.defineProperty
// so the install succeeds even if the runtime ships a readonly partial
// crypto object (which happens in Expo Go bridgeless mode).
//
// NOTE: this polyfill alone is not sufficient — the SDK ships its own
// `getRandomValues.native.js` that bypasses globalThis.crypto and falls back
// to Math.random when `global.nativeCallSyncHook` is undefined (Expo Go
// bridgeless). The actual fix is the Metro resolver override in
// `metro.config.js` that aliases the SDK's internal import to
// `cognito-random-override.js`. This polyfill is kept for defense-in-depth
// and to support any other consumer that reads globalThis.crypto directly.
//
// Must be imported before any module that constructs CognitoUser.
import { getRandomValues } from 'expo-crypto';

type CryptoGlobal = typeof globalThis & {
  crypto?: { getRandomValues?: typeof getRandomValues };
};

const g = globalThis as CryptoGlobal;

function install(): void {
  if (g.crypto == null) {
    try {
      Object.defineProperty(g, 'crypto', {
        value: { getRandomValues },
        writable: true,
        configurable: true,
        enumerable: true,
      });
    } catch {
      // readonly globalThis — give up silently
    }
    return;
  }

  if (typeof g.crypto.getRandomValues === 'function') return;

  try {
    Object.defineProperty(g.crypto, 'getRandomValues', {
      value: getRandomValues,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  } catch {
    // existing crypto object is frozen — try replacing the whole thing
    try {
      Object.defineProperty(g, 'crypto', {
        value: { ...g.crypto, getRandomValues },
        writable: true,
        configurable: true,
        enumerable: true,
      });
    } catch {
      // all attempts failed — downstream SDK will warn on insecure RNG
    }
  }
}

install();
