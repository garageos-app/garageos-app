// Persists the server-side push_tokens row id so DELETE (toggle off / logout)
// can target it. Separate key from auth tokens (secure-storage.ts) — cleared on
// explicit logout/deregister.
import * as SecureStore from 'expo-secure-store';

const KEY = 'push_token_id';

export async function readPushTokenId(): Promise<string | null> {
  return SecureStore.getItemAsync(KEY);
}
export async function writePushTokenId(id: string): Promise<void> {
  await SecureStore.setItemAsync(KEY, id);
}
export async function clearPushTokenId(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY);
}
