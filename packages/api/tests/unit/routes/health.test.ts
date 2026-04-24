import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../../src/server.js';
import { PROBLEM_JSON_CONTENT_TYPE } from '../../../src/config/constants.js';

describe('GET /health', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildServer();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 200 with status ok, ISO timestamp, and version', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      status: 'ok',
      version: expect.any(String) as unknown,
    });
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    // ISO string must parse back to a valid Date.
    expect(Number.isNaN(new Date(body.timestamp as string).getTime())).toBe(false);
  });

  it('auto-generates x-request-id when the client omits it', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });

    const rid = res.headers['x-request-id'];
    expect(rid).toBeTypeOf('string');
    expect(rid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('preserves client-supplied x-request-id', async () => {
    const clientId = '01HKXN5A-MOCK-4BE3-9DCB-test00000001';
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': clientId },
    });

    expect(res.headers['x-request-id']).toBe(clientId);
  });
});

describe('unknown route', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildServer();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 404 in RFC 7807 Problem Details format', async () => {
    const res = await app.inject({ method: 'GET', url: '/does-not-exist' });

    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/NOT_FOUND',
      title: 'Resource not found',
      status: 404,
      instance: '/does-not-exist',
      request_id: expect.any(String) as unknown,
    });
  });
});
