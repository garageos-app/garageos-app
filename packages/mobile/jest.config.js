// Default EXPO_PUBLIC_* env vars must be set BEFORE Jest spawns workers,
// because babel-preset-expo's inline-env-vars plugin (active when
// NODE_ENV !== 'development') replaces process.env.EXPO_PUBLIC_* with the
// value seen at babel-jest transform time. Setting them inside setupFiles
// would be too late — transforms happen before setupFiles execution.
process.env.EXPO_PUBLIC_API_URL ??= 'https://api.test.example.com';
process.env.EXPO_PUBLIC_COGNITO_CLIENTI_POOL_ID ??= 'eu-west-1_TestPool';
process.env.EXPO_PUBLIC_COGNITO_CLIENTI_CLIENT_ID ??= 'testclientid';

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
  },
};
