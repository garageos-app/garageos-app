/* eslint-disable @typescript-eslint/no-require-imports */
// Metro resolver alias target — overrides amazon-cognito-identity-js's
// own getRandomValues.native.js which uses an insecure Math.random fallback
// when global.nativeCallSyncHook is undefined (Expo Go bridgeless mode).
//
// This file is JS (not TS) because the SDK's internal call site uses CJS
// interop (default + named) and a flat JS export keeps that pattern intact.

const { getRandomValues } = require('expo-crypto');

module.exports = getRandomValues;
module.exports.default = getRandomValues;
