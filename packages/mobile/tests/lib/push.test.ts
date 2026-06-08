import * as Notifications from 'expo-notifications';

import { ensurePushPermission, getDevicePushToken, buildRegistrationPayload } from '@/lib/push';

describe('push lib', () => {
  beforeEach(() => jest.clearAllMocks());

  it('ensurePushPermission returns granted when already granted', async () => {
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({
      status: 'granted',
      canAskAgain: true,
    });
    expect(await ensurePushPermission()).toBe('granted');
    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it('requests permission when undetermined, maps denial', async () => {
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({
      status: 'undetermined',
      canAskAgain: true,
    });
    (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValueOnce({
      status: 'denied',
      canAskAgain: true,
    });
    expect(await ensurePushPermission()).toBe('denied');
  });

  it('maps denied + cannot-ask-again to blocked', async () => {
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({
      status: 'denied',
      canAskAgain: false,
    });
    expect(await ensurePushPermission()).toBe('blocked');
  });

  it('getDevicePushToken returns the token string', async () => {
    expect(await getDevicePushToken()).toBe('ExpoPushToken[jest]');
    expect(Notifications.getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: 'jest-project' });
  });

  it('buildRegistrationPayload includes platform + deviceName', () => {
    const p = buildRegistrationPayload('ExpoPushToken[jest]');
    expect(p.expoPushToken).toBe('ExpoPushToken[jest]');
    expect(['ios', 'android']).toContain(p.platform);
    expect(p.deviceName).toBe('Jest Device');
  });
});
