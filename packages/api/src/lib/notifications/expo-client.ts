import { Expo, type ExpoPushMessage, type ExpoPushTicket } from 'expo-server-sdk';

export type { ExpoPushMessage, ExpoPushTicket };

// Lazy singleton — mirrors lib/ses-client.ts. Tests reset it so the
// expo-server-sdk mock is re-read on each setup.
let _client: Expo | null = null;

export function getExpoClient(): Expo {
  if (_client) return _client;
  _client = new Expo(
    process.env.EXPO_ACCESS_TOKEN ? { accessToken: process.env.EXPO_ACCESS_TOKEN } : {},
  );
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
