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
