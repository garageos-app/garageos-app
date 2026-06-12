// Thin imperative wrappers around expo-notifications / expo-device, isolated so
// the rest of the app (and its tests) never touch the native modules directly.
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';

import type { PushPermission, PushRegistrationPayload } from './types/push';

// Request OS notification permission if needed. 'blocked' = the user denied and
// the OS won't show the prompt again → the UI must point them to Settings.
export async function ensurePushPermission(): Promise<PushPermission> {
  const current = await Notifications.getPermissionsAsync();
  if (current.status === 'granted') return 'granted';
  if (current.status === 'denied' && current.canAskAgain === false) return 'blocked';
  const req = await Notifications.requestPermissionsAsync();
  if (req.status === 'granted') return 'granted';
  return req.canAskAgain === false ? 'blocked' : 'denied';
}

// Read-only permission check used to derive the initial toggle state on mount.
export async function getPushPermissionStatus(): Promise<PushPermission> {
  const current = await Notifications.getPermissionsAsync();
  if (current.status === 'granted') return 'granted';
  return current.status === 'denied' && current.canAskAgain === false ? 'blocked' : 'denied';
}

// Acquire the Expo push token. Requires extra.eas.projectId (set by `eas init`).
export async function getDevicePushToken(): Promise<string> {
  const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
  if (!projectId) {
    throw new Error('EAS projectId mancante: esegui `eas init` e imposta extra.eas.projectId.');
  }
  const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
  return data;
}

// Show notifications as a system banner while the app is foregrounded (the
// expo-notifications default swallows them). Must run at module scope before
// any notification can be received. SDK 52 NotificationBehavior shape —
// shouldShowBanner/shouldShowList are SDK 53+.
export function configureForegroundNotificationDisplay(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
}

export function buildRegistrationPayload(expoPushToken: string): PushRegistrationPayload {
  const platform = Platform.OS === 'ios' ? 'ios' : 'android';
  const deviceName = Device.deviceName ?? undefined;
  const appVersion = Constants.expoConfig?.version;
  return {
    expoPushToken,
    platform,
    ...(deviceName ? { deviceName } : {}),
    ...(appVersion ? { appVersion } : {}),
  };
}
