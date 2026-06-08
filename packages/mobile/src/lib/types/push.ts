export type PushRegistrationPayload = {
  expoPushToken: string;
  platform: 'ios' | 'android';
  deviceName?: string;
  appVersion?: string;
};

export type PushPermission = 'granted' | 'denied' | 'blocked';
