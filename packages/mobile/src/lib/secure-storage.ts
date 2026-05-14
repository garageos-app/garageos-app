import * as SecureStore from 'expo-secure-store';

const TOKENS_KEY = 'garageos.tokens';

export type StoredTokens = {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  customerId: string;
  email: string;
};

export async function readTokens(): Promise<StoredTokens | null> {
  try {
    const raw = await SecureStore.getItemAsync(TOKENS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'idToken' in parsed &&
      'refreshToken' in parsed &&
      'accessToken' in parsed &&
      'customerId' in parsed &&
      'email' in parsed
    ) {
      return parsed as StoredTokens;
    }
    // Malformed payload: drop it so next bootstrap is clean
    await SecureStore.deleteItemAsync(TOKENS_KEY);
    return null;
  } catch {
    return null;
  }
}

export async function writeTokens(tokens: StoredTokens): Promise<void> {
  await SecureStore.setItemAsync(TOKENS_KEY, JSON.stringify(tokens));
}

export async function clearTokens(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKENS_KEY);
}
