// Tests for push-prompt-storage.
// AsyncStorage is globally mocked in jest.setup.ts via the official
// @react-native-async-storage/async-storage/jest/async-storage-mock — the mock
// exports a CJS object whose methods are jest.fn()s, so we can spy/override them
// here with mockResolvedValueOnce / mockRejectedValueOnce.
import AsyncStorage from '@react-native-async-storage/async-storage';

import { readSoftAskSeen, markSoftAskSeen } from '@/lib/push-prompt-storage';

const KEY = 'garageos.push.softAskSeen';

describe('push-prompt-storage', () => {
  it('readSoftAskSeen returns false when getItem resolves null', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
    expect(await readSoftAskSeen()).toBe(false);
    expect(AsyncStorage.getItem).toHaveBeenCalledWith(KEY);
  });

  it('markSoftAskSeen calls setItem with the correct key and value', async () => {
    await markSoftAskSeen();
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(KEY, '1');
  });

  it('readSoftAskSeen returns true when getItem resolves "1"', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('1');
    expect(await readSoftAskSeen()).toBe(true);
  });

  it('readSoftAskSeen returns false (not throw) when getItem rejects', async () => {
    (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(readSoftAskSeen()).resolves.toBe(false);
  });
});
