/* eslint-disable @typescript-eslint/no-require-imports */
// Metro requires CommonJS config files; ESM exports are not supported here.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

config.resolver.disableHierarchicalLookup = true;

// Override amazon-cognito-identity-js's getRandomValues with our
// expo-crypto-backed implementation. SDK's own native.js uses Math.random
// fallback when global.nativeCallSyncHook is missing (Expo Go bridgeless).
const cognitoRandomOverride = path.resolve(projectRoot, 'src/lib/cognito-random-override.js');
const defaultResolver = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    moduleName === './getRandomValues' &&
    context.originModulePath &&
    context.originModulePath.includes('amazon-cognito-identity-js')
  ) {
    return {
      filePath: cognitoRandomOverride,
      type: 'sourceFile',
    };
  }
  if (defaultResolver) {
    return defaultResolver(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
