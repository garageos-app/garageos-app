// Test-only JWT helpers. Generate RS256 key pairs (one per simulated
// Cognito pool) and sign tokens with the claim shape the real Cognito
// issuer produces. Two consumers:
//
//   - Unit tests: feed the public JWK directly into the auth plugin's
//     in-memory verifier path (no HTTP involved).
//   - Integration tests: publish the public JWK through a local HTTP
//     mock server (tests/helpers/jwks-server.ts) so the real
//     aws-jwt-verify hydrate step can fetch it.
//
// jose is a devDependency precisely to sign tokens here —
// aws-jwt-verify only verifies, not signs.

import { exportJWK, generateKeyPair, importJWK, SignJWT, type CryptoKey, type JWK } from 'jose';

export type TestPool = 'officine' | 'clienti' | 'platform-admins';

export interface TestKeyPair {
  privateKey: CryptoKey;
  publicJwk: JWK;
  kid: string;
}

let officineKey: TestKeyPair | null = null;
let clientiKey: TestKeyPair | null = null;
let platformAdminsKey: TestKeyPair | null = null;

// Defaults used by helpers when an option is omitted. They match the
// placeholders in tests/unit/setup.ts / tests/integration/globalSetup.ts
// so `signTestToken({ pool: 'officine' })` produces a token the default
// verifier config accepts without ceremony.
const DEFAULT_REGION = 'eu-central-1';
const DEFAULT_POOL_IDS: Record<TestPool, string> = {
  officine: 'eu-central-1_TESTOFFICINE',
  clienti: 'eu-central-1_TESTCLIENTI',
  'platform-admins': 'eu-central-1_TESTPLATFORMADMINS',
};
const DEFAULT_CLIENT_IDS: Record<TestPool, string> = {
  officine: 'test-officine-client',
  clienti: 'test-clienti-client',
  'platform-admins': 'test-platform-admins-client',
};

async function buildPair(kid: string): Promise<TestKeyPair> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  return {
    privateKey,
    publicJwk: { ...publicJwk, kid, use: 'sig', alg: 'RS256' },
    kid,
  };
}

// Env var names used to hand off the generated keys from the
// globalSetup process to the forked worker processes. vitest (pool:
// forks + fileParallelism: false) runs tests in a worker separate from
// the main process that ran globalSetup — the JWKS mock server lives
// in main, so if workers generated their own keys the published JWKS
// and the signing keys would mismatch and every signature would fail.
const HANDOFF_ENV = {
  officine: 'TEST_JWT_OFFICINE_KEY_BUNDLE',
  clienti: 'TEST_JWT_CLIENTI_KEY_BUNDLE',
  'platform-admins': 'TEST_JWT_PLATFORM_ADMINS_KEY_BUNDLE',
} as const;

interface KeyBundle {
  privateJwk: JWK;
  publicJwk: JWK;
  kid: string;
}

async function hydrateFromBundle(bundle: KeyBundle): Promise<TestKeyPair> {
  const privateKey = (await importJWK(bundle.privateJwk, 'RS256')) as CryptoKey;
  return { privateKey, publicJwk: bundle.publicJwk, kid: bundle.kid };
}

async function exportBundle(pair: TestKeyPair): Promise<KeyBundle> {
  const privateJwk = await exportJWK(pair.privateKey);
  return { privateJwk, publicJwk: pair.publicJwk, kid: pair.kid };
}

// Idempotent. Preferred order:
//   1. If module-level keys are already populated, reuse them.
//   2. Otherwise, if HANDOFF_ENV vars are set, hydrate from them.
//   3. Otherwise, generate fresh pairs (unit-test path).
export async function initKeys(): Promise<void> {
  if (officineKey && clientiKey && platformAdminsKey) return;

  const officineBundleJson = process.env[HANDOFF_ENV.officine];
  const clientiBundleJson = process.env[HANDOFF_ENV.clienti];
  const platformAdminsBundleJson = process.env[HANDOFF_ENV['platform-admins']];

  if (officineBundleJson && clientiBundleJson) {
    const [o, c] = await Promise.all([
      hydrateFromBundle(JSON.parse(officineBundleJson) as KeyBundle),
      hydrateFromBundle(JSON.parse(clientiBundleJson) as KeyBundle),
    ]);
    officineKey = o;
    clientiKey = c;
    // Platform-admins key: hydrate from env if the integration globalSetup
    // published it; otherwise generate fresh (no integration tests for this
    // pool yet, so the handoff var may be absent).
    if (platformAdminsBundleJson) {
      platformAdminsKey = await hydrateFromBundle(
        JSON.parse(platformAdminsBundleJson) as KeyBundle,
      );
    } else {
      platformAdminsKey = await buildPair('platform-admins-kid-1');
    }
    return;
  }

  const [o, c, p] = await Promise.all([
    buildPair('officine-kid-1'),
    buildPair('clienti-kid-1'),
    buildPair('platform-admins-kid-1'),
  ]);
  officineKey = o;
  clientiKey = c;
  platformAdminsKey = p;
}

// Called by tests/integration/globalSetup.ts after initKeys() so the
// generated key material can be inherited by worker processes through
// the environment. Worker-side initKeys() reads these back before any
// test signs a token.
export async function publishKeysToEnv(): Promise<void> {
  await initKeys();
  const [officine, clienti, platformAdmins] = await Promise.all([
    exportBundle(getTestKey('officine')),
    exportBundle(getTestKey('clienti')),
    exportBundle(getTestKey('platform-admins')),
  ]);
  process.env[HANDOFF_ENV.officine] = JSON.stringify(officine);
  process.env[HANDOFF_ENV.clienti] = JSON.stringify(clienti);
  process.env[HANDOFF_ENV['platform-admins']] = JSON.stringify(platformAdmins);
}

export function getTestKey(pool: TestPool): TestKeyPair {
  let key: TestKeyPair | null;
  if (pool === 'officine') {
    key = officineKey;
  } else if (pool === 'clienti') {
    key = clientiKey;
  } else {
    key = platformAdminsKey;
  }
  if (!key) {
    throw new Error('initKeys() must be awaited before using getTestKey/signTestToken');
  }
  return key;
}

// Issuer layout matches Cognito: https://cognito-idp.<region>.amazonaws.com/<pool>
export function buildIssuer(poolId: string, region: string = DEFAULT_REGION): string {
  return `https://cognito-idp.${region}.amazonaws.com/${poolId}`;
}

export interface SignOpts {
  pool: TestPool;
  // Claim overrides
  sub?: string;
  email?: string;
  tenantId?: string; // officine only; default random UUID
  role?: 'super_admin' | 'mechanic'; // officine only; default 'mechanic'
  locationId?: string; // officine only; default omitted (BR-204 super_admin)
  customerId?: string; // clienti only; default random UUID
  // Token frame overrides
  region?: string;
  poolId?: string;
  audience?: string;
  expSecondsFromNow?: number;
  tokenUse?: 'id' | 'access';
  // Misc
  extraClaims?: Record<string, unknown>;
  // Sign with a different key's private material (simulates rogue issuer)
  signingKey?: TestKeyPair;
}

export async function signTestToken(opts: SignOpts): Promise<string> {
  const region = opts.region ?? DEFAULT_REGION;
  const poolId = opts.poolId ?? DEFAULT_POOL_IDS[opts.pool];
  const aud = opts.audience ?? DEFAULT_CLIENT_IDS[opts.pool];
  const key = opts.signingKey ?? getTestKey(opts.pool);

  const claims: Record<string, unknown> = {
    sub: opts.sub ?? crypto.randomUUID(),
    aud,
    email: opts.email ?? 'user@test.garageos.it',
    token_use: opts.tokenUse ?? 'id',
  };

  if (opts.pool === 'officine') {
    claims['custom:tenant_id'] = opts.tenantId ?? crypto.randomUUID();
    claims['custom:role'] = opts.role ?? 'mechanic';
    if (opts.locationId !== undefined) {
      claims['custom:location_id'] = opts.locationId;
    }
  } else if (opts.pool === 'clienti') {
    claims['custom:customer_id'] = opts.customerId ?? crypto.randomUUID();
  }
  // platform-admins: no pool-specific extra claims required

  Object.assign(claims, opts.extraClaims ?? {});

  return await new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: key.kid })
    .setIssuer(buildIssuer(poolId, region))
    .setIssuedAt()
    .setExpirationTime(`${opts.expSecondsFromNow ?? 3600}s`)
    .sign(key.privateKey);
}
