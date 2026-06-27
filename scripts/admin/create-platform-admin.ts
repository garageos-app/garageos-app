#!/usr/bin/env node
/**
 * Operator-only: create a platform-admin user in the Cognito platform-admins
 * pool. The user is left in FORCE_CHANGE_PASSWORD state; a temporary password
 * is printed once. The admin must log in to the admin console and set a
 * permanent password on first login.
 *
 * Usage:
 *   pnpm tsx scripts/admin/create-platform-admin.ts <email> <firstName> <lastName>
 *
 * Exit codes:
 *   0 — success, credentials printed to stdout
 *   1 — missing argument or missing COGNITO_PLATFORM_ADMINS_POOL_ID env var
 *   2 — AWS / Cognito error
 */

import { randomInt } from 'node:crypto';

import {
  AdminCreateUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';

const USAGE =
  'Usage: pnpm tsx scripts/admin/create-platform-admin.ts <email> <firstName> <lastName>';

// 24-char password guaranteeing all four character classes for any pool policy.
// Ambiguity-free alphabets (no 0/O, 1/l/I) to ease manual entry.
// Verbatim from scripts/rebuild-tenants.mjs:46-56, typed for TS.
function randomPassword(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%^&*';
  const all = upper + lower + digits + symbols;
  // charAt always returns string (unlike bracket indexing which is string | undefined in strict mode).
  const pick = (set: string) => set.charAt(randomInt(set.length));
  let pwd = pick(upper) + pick(lower) + pick(digits) + pick(symbols);
  while (pwd.length < 24) pwd += pick(all);
  return pwd;
}

async function main() {
  const args = process.argv.slice(2);
  const email = args[0];
  const firstName = args[1];
  const lastName = args[2];

  // Validate args first so the script fails fast offline (no AWS call needed).
  if (!email || !firstName || !lastName) {
    console.error(USAGE);
    process.exit(1);
  }

  // Validate the pool id env var before constructing the Cognito client.
  const userPoolId = process.env.COGNITO_PLATFORM_ADMINS_POOL_ID;
  if (!userPoolId) {
    console.error('Error: COGNITO_PLATFORM_ADMINS_POOL_ID env var is required.');
    process.exit(1);
  }

  const region = process.env.AWS_REGION ?? 'eu-central-1';
  const client = new CognitoIdentityProviderClient({ region });
  const temporaryPassword = randomPassword();

  try {
    await client.send(
      new AdminCreateUserCommand({
        UserPoolId: userPoolId,
        Username: email,
        MessageAction: 'SUPPRESS',
        TemporaryPassword: temporaryPassword,
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'email_verified', Value: 'true' },
          { Name: 'given_name', Value: firstName },
          { Name: 'family_name', Value: lastName },
        ],
      }),
    );

    // Print credentials once; the admin must change the password at first login.
    console.log(`Email:    ${email}`);
    console.log(`Password: ${temporaryPassword}`);
    console.log(
      `Al primo accesso vai su https://admin.garageos.aifollyadvisor.com e imposta una password definitiva.`,
    );
    process.exit(0);
  } catch (err) {
    console.error('Cognito error:', err instanceof Error ? err.message : err);
    process.exit(2);
  }
}

void main();
