// Runs via setupFilesAfterEnv — Jest test framework is initialized here, so
// beforeEach is available. Clears the in-memory expo-secure-store Map and
// AsyncStorage between tests to prevent cross-test pollution.
beforeEach(async () => {
  const reset = (globalThis as { __mobileMockReset?: () => Promise<void> }).__mobileMockReset;
  if (reset) await reset();
});
