import { readPushTokenId, writePushTokenId, clearPushTokenId } from '@/lib/push-token-storage';

describe('push-token-storage', () => {
  beforeEach(async () => {
    await clearPushTokenId();
  });

  it('round-trips the token id', async () => {
    expect(await readPushTokenId()).toBeNull();
    await writePushTokenId('abc-123');
    expect(await readPushTokenId()).toBe('abc-123');
    await clearPushTokenId();
    expect(await readPushTokenId()).toBeNull();
  });
});
