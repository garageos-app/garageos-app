import { Buffer } from 'node:buffer';

import { JwtRsaVerifier } from 'aws-jwt-verify';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { createLocalJWKSet, jwtVerify, type JWK, type JWTPayload } from 'jose';

import { env } from '../config/env.js';

export type AuthPool = 'officine' | 'clienti';

export interface CognitoIdTokenPayload extends JWTPayload {
  token_use?: 'id' | 'access';
  email?: string;
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
  // Unit-test escape hatch: when either array is set, the plugin builds
  // an in-memory verifier backed by jose's createLocalJWKSet, skipping
  // any HTTP fetch to Cognito. Integration tests and production leave
  // both undefined and exercise the real HTTP path via
  // aws-jwt-verify + JWKS URL (derived from pool ID, overridable
  // through COGNITO_*_JWKS_URL_OVERRIDE).
  officineJwks?: JWK[];
  clientiJwks?: JWK[];
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

// In-memory verifier (unit tests only). Uses jose because aws-jwt-verify
// does not expose a public path to inject pre-fetched JWKS keys.
function buildInMemoryVerifier(opts: AuthPluginOptions): JwtVerifier {
  const officineJwks = opts.officineJwks?.length
    ? createLocalJWKSet({ keys: opts.officineJwks })
    : null;
  const clientiJwks = opts.clientiJwks?.length
    ? createLocalJWKSet({ keys: opts.clientiJwks })
    : null;

  const officineIss = cognitoIssuer(env.COGNITO_OFFICINE_POOL_ID);
  const clientiIss = cognitoIssuer(env.COGNITO_CLIENTI_POOL_ID);

  async function runVerify(
    token: string,
    iss: string,
    pool: AuthPool,
    jwks: ReturnType<typeof createLocalJWKSet>,
    audience: string,
  ): Promise<VerifyResult> {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: iss,
      audience,
      algorithms: ['RS256'],
    });

    const tokenUse = (payload as CognitoIdTokenPayload).token_use;
    if (tokenUse !== 'id') {
      throw new Error(`Expected id token, got token_use=${tokenUse ?? 'undefined'}`);
    }

    return { pool, payload: payload as CognitoIdTokenPayload };
  }

  return {
    async verify(token) {
      const iss = peekIssuer(token);
      if (iss === officineIss && officineJwks) {
        return runVerify(token, iss, 'officine', officineJwks, env.COGNITO_OFFICINE_CLIENT_ID);
      }
      if (iss === clientiIss && clientiJwks) {
        return runVerify(token, iss, 'clienti', clientiJwks, env.COGNITO_CLIENTI_CLIENT_ID);
      }
      throw new Error(`Unknown issuer: ${iss}`);
    },
  };
}

// HTTP verifier (integration + production). One JwtRsaVerifier per pool;
// each performs issuer + audience + signature validation against a
// remote JWKS (cached by aws-jwt-verify). token_use is checked in
// customJwtCheck — Cognito-specific semantic, not covered by the
// generic RSA verifier.
function buildHttpVerifier(): JwtVerifier {
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

  const officineIss = cognitoIssuer(env.COGNITO_OFFICINE_POOL_ID);
  const clientiIss = cognitoIssuer(env.COGNITO_CLIENTI_POOL_ID);

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
      throw new Error(`Unknown issuer: ${iss}`);
    },
  };
}

const plugin: FastifyPluginAsync<AuthPluginOptions> = async (app, opts) => {
  const hasInMemoryJwks =
    (opts.officineJwks && opts.officineJwks.length > 0) ||
    (opts.clientiJwks && opts.clientiJwks.length > 0);

  const verifier = hasInMemoryJwks ? buildInMemoryVerifier(opts) : buildHttpVerifier();
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
