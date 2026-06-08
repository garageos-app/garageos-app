// expo-secure-store: in-memory mock to support round-trip tests.
// The backing Map is exposed via a globalThis reset hook so jest.afterEach.ts
// can clear it between tests — setupFiles runs once per worker, so module-level
// state persists across `it()` blocks unless explicitly reset.
jest.mock('expo-secure-store', () => {
  const state = { store: new Map<string, string>() };
  (globalThis as { __mobileMockReset?: () => Promise<void> }).__mobileMockReset = async () => {
    state.store.clear();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const AsyncStorage = require('@react-native-async-storage/async-storage');
    await (AsyncStorage.default ?? AsyncStorage).clear();
  };
  return {
    getItemAsync: jest.fn(async (key: string) => state.store.get(key) ?? null),
    setItemAsync: jest.fn(async (key: string, value: string) => {
      state.store.set(key, value);
    }),
    deleteItemAsync: jest.fn(async (key: string) => {
      state.store.delete(key);
    }),
  };
});

// AsyncStorage: in-memory mock — jest.mock factory cannot use ESM import (must
// be CJS require so Jest can hoist the call before module resolution).
jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// @expo/vector-icons pulls in expo-font/expo-asset, which fail to require under
// jest-expo. Icons are decorative in tests — mock every icon family to a host
// component so any component using them renders. The Proxy covers Ionicons,
// MaterialIcons, etc. without enumerating them.
jest.mock('@expo/vector-icons', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  return new Proxy(
    {},
    {
      get: () => (props: Record<string, unknown>) => React.createElement('Icon', props),
    },
  );
});

// expo-constants: env vars read directly via process.env.EXPO_PUBLIC_*; extra
// carries the EAS projectId (push token acquisition) and the app version.
jest.mock('expo-constants', () => ({
  // __esModule so the `import Constants from 'expo-constants'` default-import
  // interop returns this object directly (otherwise Babel double-wraps it and
  // Constants.expoConfig reads undefined).
  __esModule: true,
  default: {
    expoConfig: {
      version: '0.1.0',
      extra: { eas: { projectId: 'jest-project' } },
    },
  },
}));

// expo-notifications: in-memory permission + token. Tests override via the
// mocked fns. Default = granted + a well-formed Expo push token.
jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(async () => ({ status: 'granted', canAskAgain: true })),
  requestPermissionsAsync: jest.fn(async () => ({ status: 'granted', canAskAgain: true })),
  getExpoPushTokenAsync: jest.fn(async () => ({ data: 'ExpoPushToken[jest]' })),
  setNotificationChannelAsync: jest.fn(async () => undefined),
  AndroidImportance: { DEFAULT: 3 },
}));

// expo-device: stable device name for BR-254 upsert fixtures.
jest.mock('expo-device', () => ({ deviceName: 'Jest Device' }));
