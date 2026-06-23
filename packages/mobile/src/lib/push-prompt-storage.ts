// Persists a one-time flag indicating the soft-ask notification-permission
// modal has already been shown. Uses AsyncStorage (not SecureStore) because the
// flag is non-sensitive — it is a UI-state marker with no security implications.
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'garageos.push.softAskSeen';

/** Returns true iff the soft-ask modal has previously been marked as shown. */
export async function readSoftAskSeen(): Promise<boolean> {
  try {
    const value = await AsyncStorage.getItem(KEY);
    return value === '1';
  } catch {
    // Best-effort: a read failure must not block the UI.
    return false;
  }
}

/** Persists the flag so the soft-ask modal is not shown again. */
export async function markSoftAskSeen(): Promise<void> {
  await AsyncStorage.setItem(KEY, '1');
}
