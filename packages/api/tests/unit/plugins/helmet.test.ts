import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import helmetPlugin from '../../../src/plugins/helmet.js';

describe('helmetPlugin', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    await app.register(helmetPlugin);
    app.get('/_probe', async () => ({ ok: true }));
  });

  afterEach(async () => {
    await app.close();
  });

  it('sets strict-transport-security', async () => {
    const res = await app.inject({ method: 'GET', url: '/_probe' });
    expect(res.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
  });

  it('sets x-content-type-options: nosniff', async () => {
    const res = await app.inject({ method: 'GET', url: '/_probe' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('sets x-frame-options: DENY', async () => {
    const res = await app.inject({ method: 'GET', url: '/_probe' });
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('sets cross-origin-resource-policy: same-site', async () => {
    const res = await app.inject({ method: 'GET', url: '/_probe' });
    expect(res.headers['cross-origin-resource-policy']).toBe('same-site');
  });

  it('does NOT set content-security-policy (disabled — JSON API)', async () => {
    const res = await app.inject({ method: 'GET', url: '/_probe' });
    expect(res.headers['content-security-policy']).toBeUndefined();
  });

  it('does NOT set cross-origin-embedder-policy', async () => {
    const res = await app.inject({ method: 'GET', url: '/_probe' });
    expect(res.headers['cross-origin-embedder-policy']).toBeUndefined();
  });
});
