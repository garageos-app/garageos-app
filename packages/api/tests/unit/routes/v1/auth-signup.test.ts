import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { authSignupRoutes } from '../../../../src/routes/v1/auth-signup.js';
import { registerErrorHandler } from '../../../../src/plugins/error-handler.js';

let app: FastifyInstance;

beforeEach(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(authSignupRoutes);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe('POST /v1/auth/signup — body validation', () => {
  it('returns 400 when type is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email: 'a@b.it', password: 'Secret123', firstName: 'M', lastName: 'R' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when email is malformed', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        type: 'customer',
        email: 'not-an-email',
        password: 'Secret123',
        firstName: 'M',
        lastName: 'R',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when password is shorter than 8 chars', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        type: 'customer',
        email: 'a@b.it',
        password: 'short',
        firstName: 'M',
        lastName: 'R',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when firstName is empty', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        type: 'customer',
        email: 'a@b.it',
        password: 'Secret123',
        firstName: '',
        lastName: 'R',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 422 auth.signup.tenant_signup_not_supported for type=tenant_admin', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { type: 'tenant_admin', businessName: 'X' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('auth.signup.tenant_signup_not_supported');
  });
});
