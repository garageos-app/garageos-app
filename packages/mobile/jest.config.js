// Default EXPO_PUBLIC_* env vars must be set BEFORE Jest spawns workers,
// because babel-preset-expo's inline-env-vars plugin (active when
// NODE_ENV !== 'development') replaces process.env.EXPO_PUBLIC_* with the
// value seen at babel-jest transform time. Setting them inside setupFiles
// would be too late — transforms happen before setupFiles execution.
process.env.EXPO_PUBLIC_API_URL ??= 'https://api.test.example.com';
process.env.EXPO_PUBLIC_COGNITO_CLIENTI_POOL_ID ??= 'eu-west-1_TestPool';
process.env.EXPO_PUBLIC_COGNITO_CLIENTI_CLIENT_ID ??= 'testclientid';
process.env.EXPO_PUBLIC_COGNITO_HOSTED_UI ??=
  'https://test-clienti.auth.eu-central-1.amazoncognito.com';

module.exports = {
  preset: 'jest-expo',
  setupFiles: ['<rootDir>/jest.setup.ts'],
  // Runs after the Jest test framework is initialized (beforeEach available).
  // Resets the in-memory expo-secure-store Map + AsyncStorage between tests.
  setupFilesAfterEnv: ['<rootDir>/jest.afterEach.ts'],
  clearMocks: true,
  // NOTE: pnpm hoists packages under node_modules/.pnpm/<pkg>@<ver>/node_modules/<pkg>.
  // The negative lookahead must allow the `.pnpm/` segment plus the package allowlist.
  transformIgnorePatterns: [
    'node_modules/(?!(\\.pnpm/)?((jest-)?react-native|@react-native(-community)?|@react-native\\+|expo(nent)?|@expo(nent)?|@expo-google-fonts|react-navigation|@react-navigation|@tanstack|amazon-cognito-identity-js|@react-native-async-storage|react-native-url-polyfill))',
  ],
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/.expo/'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    // Force a single React instance. pnpm's `node-linker=hoisted` (required for
    // Metro in this workspace) physically copies `react` into
    // packages/mobile/node_modules/react, while `react-test-renderer` resolves
    // `react` via the root `.pnpm/react@<ver>` symlink — yielding two instances
    // and a null hooks dispatcher (`useState` throws). Pinning `react` to the
    // local copy collapses both back to one instance. CI Linux uses symlinks
    // throughout and is unaffected either way.
    '^react$': '<rootDir>/node_modules/react',
  },
};
