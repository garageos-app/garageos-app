# @garageos/mobile

GarageOS mobile B2C app — Expo SDK 52 + React Native 0.76 + Cognito Pool Clienti.

## Status

Scaffold (slice K). Read-only: login → vehicle list → detail with timeline. Write features in subsequent slices.

## Dev quickstart

1. Install deps (from repo root): `pnpm install`
2. Create `packages/mobile/.env.local`:

   ```
   EXPO_PUBLIC_API_URL=https://api.garageos.aifollyadvisor.com
   EXPO_PUBLIC_COGNITO_CLIENTI_POOL_ID=<from CDK stack output ClientiUserPoolId>
   EXPO_PUBLIC_COGNITO_CLIENTI_CLIENT_ID=<from CDK stack output ClientiUserPoolClientId>
   ```

3. Start: `pnpm --filter @garageos/mobile start`
4. Scan QR with Expo Go (iOS/Android)

## Test

```bash
pnpm --filter @garageos/mobile typecheck
pnpm --filter @garageos/mobile test
```

## Troubleshooting

- **"global is not defined"** (amazon-cognito-identity-js): polyfill via `react-native-url-polyfill/auto` imported at top of `app/_layout.tsx`.
- **Metro module not found in monorepo**: check `metro.config.js` watchFolders + nodeModulesPaths.
- **Expo Go connection refused**: same Wi-Fi network, allow LAN access in firewall.

## Features in this slice

- F-CLI-002 login Cognito (email/password)
- F-CLI-105 vehicle list
- F-CLI-106 vehicle detail
- F-CLI-201 timeline interventi officina
- F-CLI-205 visual badge officina/privato

## Not in this slice

See `docs/superpowers/specs/2026-05-14-mobile-b2c-scaffold-design.md` §2.
