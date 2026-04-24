import { type AddressInfo } from 'node:net';
import { createServer, type Server, type ServerResponse } from 'node:http';

import { getTestKey, initKeys } from './jwt.js';

// Minimal HTTP server that publishes the test key pairs' public JWKs at
// Cognito-shaped paths. Integration tests set
// COGNITO_*_JWKS_URL_OVERRIDE to the two URLs below so the real
// aws-jwt-verify hydrate step fetches our keys instead of going to
// cognito-idp.<region>.amazonaws.com.
//
// Separate paths per pool — aws-jwt-verify caches JWKS per URL and we
// do not want a key from one pool to ever satisfy a kid lookup from
// the other pool. Same-origin (127.0.0.1) keeps it reachable from
// Testcontainers on the same docker/loopback network.

export interface JwksServer {
  officineUrl: string;
  clientiUrl: string;
  close(): Promise<void>;
}

function writeJwks(res: ServerResponse, jwks: unknown): void {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(jwks));
}

export async function startJwksServer(): Promise<JwksServer> {
  // Keys must exist before we publish them. Safe to call multiple
  // times — initKeys is idempotent.
  await initKeys();

  const server: Server = createServer((req, res) => {
    if (req.url === '/officine/.well-known/jwks.json') {
      writeJwks(res, { keys: [getTestKey('officine').publicJwk] });
      return;
    }
    if (req.url === '/clienti/.well-known/jwks.json') {
      writeJwks(res, { keys: [getTestKey('clienti').publicJwk] });
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const addr = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${addr.port}`;

  return {
    officineUrl: `${base}/officine/.well-known/jwks.json`,
    clientiUrl: `${base}/clienti/.well-known/jwks.json`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
