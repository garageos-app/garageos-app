import { Expo, type ExpoPushMessage, type ExpoPushTicket } from 'expo-server-sdk';

export type { ExpoPushMessage, ExpoPushTicket };

// Lazy singleton — mirrors lib/ses-client.ts. Tests reset it so the
// expo-server-sdk mock is re-read on each setup.
let _client: Expo | null = null;

// CDK seeds the app secret with this sentinel until an operator sets the real
// value (see APPENDICE_C). Sending it as a real access token could make Expo
// reject every push and trip BR-254 mass-deactivation, so we treat it as unset.
const PLACEHOLDER_SECRET = 'REPLACE_AFTER_DEPLOY';

export function getExpoClient(): Expo {
  if (_client) return _client;
  const accessToken = process.env.EXPO_ACCESS_TOKEN;
  const useToken = accessToken && accessToken !== PLACEHOLDER_SECRET;
  _client = new Expo(useToken ? { accessToken } : {});
  return _client;
}

// Test-only reset hook. Production code never imports this.
export function _resetExpoClientForTests(): void {
  _client = null;
}

export function isValidExpoPushToken(token: string): boolean {
  return Expo.isExpoPushToken(token);
}

// Expo caps a request at 100 messages. Chunk, send each chunk sequentially,
// and flatten the tickets back in input order so ticket[i] aligns with
// message[i] (the push channel relies on this for BR-254 token mapping).
export async function sendExpoPushChunks(messages: ExpoPushMessage[]): Promise<ExpoPushTicket[]> {
  const client = getExpoClient();
  const chunks = client.chunkPushNotifications(messages);
  const tickets: ExpoPushTicket[] = [];
  for (const chunk of chunks) {
    const chunkTickets = await client.sendPushNotificationsAsync(chunk);
    tickets.push(...chunkTickets);
  }
  return tickets;
}
