import { Buffer } from 'node:buffer';

import { JwtRsaVerifier } from 'aws-jwt-verify';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import type { JWK, JWTPayload } from 'jose';

import { env } from '../config/env.js';

export type AuthPool = 'officine' | 'clienti' | 'platform-admins';

export interface CognitoIdTokenPayload extends JWTPayload {
  token_use?: 'id' | 'access';
  email?: string;
  // Standard Cognito attributes used by the platform-admins pool (Slice 0).
  given_name?: string;
  family_name?: string;
  'custom:tenant_id'?: string;
  'custom:role'?: string;
  'custom:location_id'?: string;
  'custom:customer_id'?: string;
}

export interface VerifyResult {
  pool: AuthPool;
  payload: CognitoIdTokenPayload;
}

export interface JwtVerifier {
  verify(token: string): Promise<VerifyResult>;
}

export interface AuthPluginOptions {
  // Pre-seed the aws-jwt-verify JWKS cache with in-memory keys. When
  // set, the verifier never makes an HTTP call — useful for unit and
  // integration tests where the signing key pair is generated in
  // process (see tests/helpers/jwt.ts).
  //
  // Production leaves all three undefined: the verifier lazily fetches the
  // real JWKS from AWS on the first request. aws-jwt-verify's HTTP
  // client only supports https, so this option — not a local mock
  // server — is the right escape hatch for tests.
  officineJwks?: JWK[];
  clientiJwks?: JWK[];
  // Only relevant when COGNITO_PLATFORM_ADMINS_POOL_ID and _CLIENT_ID are
  // set in env (see platformAdminsConfigured in buildVerifier). When those
  // vars are absent the platform-admins verifier is not built and this
  // option has no effect.
  platformAdminsJwks?: JWK[];
}

function cognitoIssuer(poolId: string, region: string = env.AWS_REGION): string {
  return `https://cognito-idp.${region}.amazonaws.com/${poolId}`;
}

// Extract `iss` from the JWT payload without verifying the signature.
// Used only to select which verifier handles the token — the selected
// verifier then re-checks `iss` as part of the full signature + claims
// validation, so trusting the unverified iss here is safe.
function peekIssuer(token: string): string {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed JWT');
  }
  const payloadB64 = parts[1];
  if (!payloadB64) {
    throw new Error('Malformed JWT');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Malformed JWT payload');
  }
  if (
    !payload ||
    typeof payload !== 'object' ||
    !('iss' in payload) ||
    typeof (payload as { iss: unknown }).iss !== 'string'
  ) {
    throw new Error('Missing or invalid iss claim');
  }
  return (payload as { iss: string }).iss;
}

function buildVerifier(opts: AuthPluginOptions): JwtVerifier {
  const makePoolVerifier = (poolId: string, clientId: string, jwksUriOverride?: string) =>
    JwtRsaVerifier.create({
      issuer: cognitoIssuer(poolId),
      audience: clientId,
      ...(jwksUriOverride ? { jwksUri: jwksUriOverride } : {}),
      customJwtCheck: ({ payload }) => {
        if ((payload as CognitoIdTokenPayload).token_use !== 'id') {
          throw new Error('Expected id token');
        }
      },
    });

  const officineVerifier = makePoolVerifier(
    env.COGNITO_OFFICINE_POOL_ID,
    env.COGNITO_OFFICINE_CLIENT_ID,
    env.COGNITO_OFFICINE_JWKS_URL_OVERRIDE,
  );
  const clientiVerifier = makePoolVerifier(
    env.COGNITO_CLIENTI_POOL_ID,
    env.COGNITO_CLIENTI_CLIENT_ID,
    env.COGNITO_CLIENTI_JWKS_URL_OVERRIDE,
  );

  // Pre-seed cache with in-memory keys (tests only). Without this the
  // verifier tries to fetch the JWKS over HTTPS on first use and fails
  // in-process tests where keys are generated locally.
  if (opts.officineJwks && opts.officineJwks.length > 0) {
    officineVerifier.cacheJwks({ keys: opts.officineJwks } as never);
  }
  if (opts.clientiJwks && opts.clientiJwks.length > 0) {
    clientiVerifier.cacheJwks({ keys: opts.clientiJwks } as never);
  }

  // --- platform-admins pool (Slice 0) ---
  // Build the third verifier ONLY when both pool ID and client ID are
  // configured. This is the deploy-safety gate: operators can deploy the
  // new binary without touching Cognito or Secrets Manager; until both
  // vars are present, platform-admins tokens fall through to the existing
  // "Unknown issuer" throw, which require-auth.ts maps to 401.
  const platformAdminsConfigured =
    !!env.COGNITO_PLATFORM_ADMINS_POOL_ID && !!env.COGNITO_PLATFORM_ADMINS_CLIENT_ID;

  const platformAdminsVerifier = platformAdminsConfigured
    ? makePoolVerifier(
        env.COGNITO_PLATFORM_ADMINS_POOL_ID!,
        env.COGNITO_PLATFORM_ADMINS_CLIENT_ID!,
        env.COGNITO_PLATFORM_ADMINS_JWKS_URL_OVERRIDE,
      )
    : undefined;

  if (platformAdminsVerifier && opts.platformAdminsJwks?.length) {
    platformAdminsVerifier.cacheJwks({ keys: opts.platformAdminsJwks } as never);
  }

  const officineIss = cognitoIssuer(env.COGNITO_OFFICINE_POOL_ID);
  const clientiIss = cognitoIssuer(env.COGNITO_CLIENTI_POOL_ID);
  const platformAdminsIss = platformAdminsConfigured
    ? cognitoIssuer(env.COGNITO_PLATFORM_ADMINS_POOL_ID!)
    : undefined;

  return {
    async verify(token) {
      const iss = peekIssuer(token);
      if (iss === officineIss) {
        const payload = (await officineVerifier.verify(token)) as CognitoIdTokenPayload;
        return { pool: 'officine', payload };
      }
      if (iss === clientiIss) {
        const payload = (await clientiVerifier.verify(token)) as CognitoIdTokenPayload;
        return { pool: 'clienti', payload };
      }
      if (platformAdminsVerifier && iss === platformAdminsIss) {
        const payload = (await platformAdminsVerifier.verify(token)) as CognitoIdTokenPayload;
        return { pool: 'platform-admins', payload };
      }
      throw new Error(`Unknown issuer: ${iss}`);
    },
  };
}

const plugin: FastifyPluginAsync<AuthPluginOptions> = async (app, opts) => {
  const verifier = buildVerifier(opts);
  app.decorate('jwtVerifier', verifier);
};

// fp-wrapped so `app.jwtVerifier` is reachable from route handlers
// registered on the outer FastifyInstance (same rationale as the
// database plugin — see src/plugins/database.ts).
export default fp(plugin, {
  name: 'auth',
  fastify: '5.x',
});

declare module 'fastify' {
  interface FastifyInstance {
    jwtVerifier: JwtVerifier;
  }
}
