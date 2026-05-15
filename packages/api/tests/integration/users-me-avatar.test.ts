// packages/api/tests/integration/users-me-avatar.test.ts
//
// Integration tests for the 3 avatar endpoints:
//   POST /v1/users/me/avatar/upload-url
//   POST /v1/users/me/avatar/confirm
//   DELETE /v1/users/me/avatar
//
// Real Postgres via Testcontainers; S3 stubbed with aws-sdk-client-mock.

import {
  DeleteObjectCommand,
  HeadObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { _resetS3ClientForTests } from '../../src/lib/s3.js';
import { buildTestServer } from './fixtures.js';
import { createTenantWithLocation, createUser, resetDb } from './helpers.js';
import { pgAdmin } from './setup.js';
import { signTestToken } from '../helpers/jwt.js';

const s3Mock = mockClient(S3Client);

// Ensure presigner has SOME credentials. Per
// feedback_aws_sdk_presigner_credentials_chain memory: the
// `@aws-sdk/s3-request-presigner` resolves credentials independently
// of S3Client.send, so aws-sdk-client-mock doesn't intercept the
// signing path. Provide fake creds without overwriting real ones.
process.env.AWS_ACCESS_KEY_ID ??= 'test-access-key';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test-secret-key';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestServer();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await resetDb();
  s3Mock.reset();
  _resetS3ClientForTests();
  s3Mock.on(PutObjectCommand).resolves({});
  s3Mock.on(HeadObjectCommand).resolves({
    ContentLength: 50_000,
    ContentType: 'image/jpeg',
  });
  s3Mock.on(DeleteObjectCommand).resolves({});
});

async function setup(
  suffix: string,
  role: 'super_admin' | 'mechanic' = 'mechanic',
): Promise<{ tenantId: string; userId: string; cognitoSub: string; token: string }> {
  const { tenantId } = await createTenantWithLocation(suffix);
  const cognitoSub = `${suffix}-sub-${crypto.randomUUID()}`;
  const { userId } = await createUser({
    tenantId,
    cognitoSub,
    email: `${suffix}@tenant.test`,
    firstName: 'Gianni',
    lastName: 'Bianchi',
    role,
  });
  const token = await signTestToken({ pool: 'officine', sub: cognitoSub, tenantId, role });
  return { tenantId, userId, cognitoSub, token };
}

function post(token: string, path: string, body: object = {}) {
  return app.inject({
    method: 'POST',
    url: path,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: body,
  });
}

// Mirrors the frontend's actual request shape: useApiFetch always sets
// `Content-Type: application/json` regardless of method, and passes body `{}`
// for DELETE (because Fastify's body parser rejects empty bodies under that
// header with 400 "Body cannot be empty…"). Don't relax this in tests —
// CI must reproduce the exact wire shape the browser sends.
function del(token: string, path: string) {
  return app.inject({
    method: 'DELETE',
    url: path,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: '{}',
  });
}

function get(token: string, path: string) {
  return app.inject({
    method: 'GET',
    url: path,
    headers: { authorization: `Bearer ${token}` },
  });
}

describe('POST /v1/users/me/avatar/upload-url', () => {
  it('200: returns presigned PUT URL + headers', async () => {
    const { token } = await setup('upload-ok');
    const res = await post(token, '/v1/users/me/avatar/upload-url');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.upload_method).toBe('PUT');
    expect(body.upload_headers).toEqual({ 'Content-Type': 'image/jpeg' });
    expect(body.upload_url).toMatch(/avatars\/users\/[a-f0-9-]+\.jpg/);
    expect(body.upload_url).toContain('X-Amz-Signature=');
    expect(typeof body.expires_at).toBe('string');
  });

  it('200: super_admin and mechanic both allowed', async () => {
    const adm = await setup('adm', 'super_admin');
    const mec = await setup('mec', 'mechanic');
    const r1 = await post(adm.token, '/v1/users/me/avatar/upload-url');
    const r2 = await post(mec.token, '/v1/users/me/avatar/upload-url');
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
  });

  it('401: no auth', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/users/me/avatar/upload-url' });
    expect(res.statusCode).toBe(401);
  });

  it('403: clienti pool rejected by requireOfficinaPool', async () => {
    const token = await signTestToken({
      pool: 'clienti',
      sub: 'c1',
      customerId: crypto.randomUUID(),
    });
    const res = await post(token, '/v1/users/me/avatar/upload-url');
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /v1/users/me/avatar/confirm', () => {
  it('200: confirm flips avatar_url + returns serialized URL', async () => {
    const { userId, token } = await setup('confirm-ok');
    const res = await post(token, '/v1/users/me/avatar/confirm');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(userId);
    expect(body.avatarUrl).toMatch(/avatars\/users\/[a-f0-9-]+\.jpg/);
    expect(body.avatarUrl).toContain('X-Amz-Signature=');

    // DB state: avatar_url stored as KEY, not URL
    const row = await pgAdmin.query<{ avatar_url: string }>(
      'SELECT avatar_url FROM users WHERE id = $1',
      [userId],
    );
    expect(row.rows[0]!.avatar_url).toMatch(/^avatars\/users\/[a-f0-9-]+\.jpg$/);
  });

  it('422 users.me.avatar.upload_not_found: HeadObject NoSuchKey', async () => {
    const { token } = await setup('confirm-missing');
    s3Mock
      .on(HeadObjectCommand)
      .rejects(new NoSuchKey({ message: 'Not Found', $metadata: { httpStatusCode: 404 } }));
    const res = await post(token, '/v1/users/me/avatar/confirm');
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('users.me.avatar.upload_not_found');
  });

  it('422 users.me.avatar.invalid_mime: HeadObject returns non-JPEG', async () => {
    const { token } = await setup('confirm-mime');
    s3Mock.on(HeadObjectCommand).resolves({ ContentLength: 100, ContentType: 'image/png' });
    const res = await post(token, '/v1/users/me/avatar/confirm');
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('users.me.avatar.invalid_mime');
  });

  it('200: idempotent re-call returns same response', async () => {
    const { token } = await setup('confirm-idem');
    const r1 = await post(token, '/v1/users/me/avatar/confirm');
    expect(r1.statusCode).toBe(200);
    const r2 = await post(token, '/v1/users/me/avatar/confirm');
    expect(r2.statusCode).toBe(200);
    // Both responses have a valid avatarUrl with the same path component
    const k1 = r1.json().avatarUrl.match(/avatars\/users\/([a-f0-9-]+)\.jpg/)![1];
    const k2 = r2.json().avatarUrl.match(/avatars\/users\/([a-f0-9-]+)\.jpg/)![1];
    expect(k1).toBe(k2);
  });
});

describe('DELETE /v1/users/me/avatar', () => {
  it('204: clears avatar_url + calls S3 DeleteObject', async () => {
    const { userId, token } = await setup('del-ok');

    // First seed an avatar
    await post(token, '/v1/users/me/avatar/confirm');
    const seed = await pgAdmin.query<{ avatar_url: string | null }>(
      'SELECT avatar_url FROM users WHERE id = $1',
      [userId],
    );
    expect(seed.rows[0]!.avatar_url).not.toBeNull();

    // Now delete
    const res = await del(token, '/v1/users/me/avatar');
    expect(res.statusCode).toBe(204);

    const after = await pgAdmin.query<{ avatar_url: string | null }>(
      'SELECT avatar_url FROM users WHERE id = $1',
      [userId],
    );
    expect(after.rows[0]!.avatar_url).toBeNull();
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(1);
  });

  it('204: idempotent — DELETE when avatar already null', async () => {
    const { userId, token } = await setup('del-idem');
    const before = await pgAdmin.query<{ avatar_url: string | null }>(
      'SELECT avatar_url FROM users WHERE id = $1',
      [userId],
    );
    expect(before.rows[0]!.avatar_url).toBeNull();

    const res = await del(token, '/v1/users/me/avatar');
    expect(res.statusCode).toBe(204);
  });

  it('204: S3 delete failure does NOT fail the request (best-effort)', async () => {
    const { token } = await setup('del-s3-fail');
    await post(token, '/v1/users/me/avatar/confirm');
    s3Mock.on(DeleteObjectCommand).rejects(new Error('network'));
    const res = await del(token, '/v1/users/me/avatar');
    expect(res.statusCode).toBe(204);
  });
});

describe('GET /v1/users/me with avatar', () => {
  it('returns avatarUrl as presigned URL when set', async () => {
    const { token } = await setup('get-with-avatar');
    await post(token, '/v1/users/me/avatar/confirm');
    const res = await get(token, '/v1/users/me');
    expect(res.statusCode).toBe(200);
    expect(res.json().avatarUrl).toMatch(/avatars\/users\/[a-f0-9-]+\.jpg/);
    expect(res.json().avatarUrl).toContain('X-Amz-Signature=');
  });

  it('returns avatarUrl=null when not set', async () => {
    const { token } = await setup('get-no-avatar');
    const res = await get(token, '/v1/users/me');
    expect(res.statusCode).toBe(200);
    expect(res.json().avatarUrl).toBeNull();
  });
});

describe('Cross-tenant isolation', () => {
  it("user from tenant A cannot affect tenant B's avatar (defense-in-depth)", async () => {
    const a = await setup('tenant-a', 'super_admin');
    const b = await setup('tenant-b', 'super_admin');

    // Confirm avatar for both — keys are user-specific so they don't collide
    await post(a.token, '/v1/users/me/avatar/confirm');
    await post(b.token, '/v1/users/me/avatar/confirm');

    // Each tenant sees their own avatar
    const ra = await get(a.token, '/v1/users/me');
    const rb = await get(b.token, '/v1/users/me');
    const keyA = ra.json().avatarUrl.match(/avatars\/users\/([a-f0-9-]+)\.jpg/)![1];
    const keyB = rb.json().avatarUrl.match(/avatars\/users\/([a-f0-9-]+)\.jpg/)![1];
    expect(keyA).not.toBe(keyB);
    expect(keyA).toBe(a.userId);
    expect(keyB).toBe(b.userId);
  });
});
