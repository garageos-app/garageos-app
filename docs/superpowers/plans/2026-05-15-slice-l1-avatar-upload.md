# Slice L1 — Avatar upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementare upload/crop/remove dell'avatar utente (F-OFF-007 follow-up) — 3 nuovi endpoint backend con S3 presigned PUT/GET, crop UI client-side react-easy-crop, output JPEG 512×512, mostrato in ProfileForm e TopBar.

**Architecture:** 2-phase upload protocol (upload-url → S3 PUT → confirm) + dedicated DELETE. Storage privato nel bucket attachment esistente, prefix `avatars/users/<userId>.jpg` (deterministico, overwrite implicit). DB stora la S3 key; serializer trasforma key → presigned GET URL 15-min nel `/users/me` response. React Query cache `users-me` con `staleTime 5 min` refresca prima della scadenza.

**Tech Stack:** Fastify + Prisma + Zod backend; `@aws-sdk/client-s3` + `s3-request-presigner` + `aws-sdk-client-mock` per test; React + Vite + Tailwind + shadcn/ui + react-easy-crop (nuova dep) + react-hook-form + TanStack Query + sonner frontend; vitest + Testing Library testing.

**Branch:** `feat/avatar-upload` (da creare partendo da `main` aggiornato a `2dcbd52`).
**Spec:** `docs/superpowers/specs/2026-05-15-l1-avatar-upload-design.md`.

---

## File map

**Backend (`packages/api/`):**
- Modify `src/lib/s3.ts` (~+5 LOC: `contentLength` optional in `PresignedPutInput`)
- Create `src/lib/avatar-presign.ts` (~30 LOC)
- Modify `src/lib/dtos/user-me.ts` (~+25 LOC: `serializeUserMe` async helper)
- Modify `src/routes/v1/users.ts` (~+5 LOC: wrap return con `serializeUserMe`)
- Modify `src/routes/v1/users-update.ts` (~+5 LOC: idem)
- Create `src/routes/v1/users-avatar.ts` (~250 LOC)
- Modify `src/server.ts` (~+2 LOC: register new plugin)
- Create `tests/unit/lib/avatar-presign.test.ts` (~60 LOC)
- Create `tests/integration/users-me-avatar.test.ts` (~350 LOC)

**Frontend (`packages/web/`):**
- Modify `package.json` (+1 dep: `react-easy-crop`)
- Create `src/lib/initials.ts` (~15 LOC)
- Create `src/lib/initials.test.ts` (~30 LOC)
- Create `src/lib/avatarCanvas.ts` (~50 LOC)
- Create `src/lib/avatarCanvas.test.ts` (~60 LOC)
- Create `src/queries/avatarUpload.ts` (~180 LOC)
- Create `src/queries/avatarUpload.test.tsx` (~150 LOC)
- Create `src/components/settings/AvatarCropDialog.tsx` (~110 LOC)
- Create `src/components/settings/AvatarCropDialog.test.tsx` (~80 LOC)
- Create `src/components/settings/AvatarSection.tsx` (~130 LOC)
- Create `src/components/settings/AvatarSection.test.tsx` (~140 LOC)
- Modify `src/components/settings/ProfileForm.tsx` (~+10 LOC: mount AvatarSection)
- Modify `src/components/layout/TopBar.tsx` (~+25 LOC: avatar widget)
- Modify `src/components/layout/TopBar.test.tsx` (~+30 LOC) — *new file if absent*
- Modify `src/queries/profileMe.ts` (~+1 comment: semantica `avatarUrl` cambia da key a URL completa)

**Docs:**
- Modify `docs/APPENDICE_A_API.md` (3 nuovi endpoint avatar + flag F-OFF-007 endpoint avatar implemented)
- Modify `docs/APPENDICE_G_ERROR_CODES.md` (3 nuovi codici)

**Totale stimato:** ~1320 LOC, sotto il soft limit 1500 di PR singolo.

---

## Pre-flight

- [ ] **Check current branch + main**

Run: `git status` and `git log --oneline -1`
Expected: clean working tree, HEAD `2dcbd52`.

- [ ] **Create feature branch**

```bash
git checkout main
git pull origin main
git checkout -b feat/avatar-upload
```

---

## Task 1: Make `presignPutObject` accept optional `contentLength`

**Files:**
- Modify: `packages/api/src/lib/s3.ts`
- Modify: `packages/api/tests/unit/lib/s3.test.ts`

Rationale: per avatar non sappiamo la size esatta del Blob a priori (il client genera dinamicamente). La deterministic key per user-id + auth-gated endpoint sono sufficienti come abuse prevention.

- [ ] **Step 1: Add failing unit test**

In `packages/api/tests/unit/lib/s3.test.ts` aggiungi (dopo il test "wraps SDK signing errors"):

```ts
  it('omits ContentLength condition when not provided', async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    const url = await presignPutObject({
      bucket: 'test-bucket',
      key: 'avatars/users/u1.jpg',
      contentType: 'image/jpeg',
      expiresInSeconds: 900,
    });
    expect(url).toMatch(/^https:\/\/test-bucket\.s3\..*amazonaws\.com\/avatars\/users\/u1\.jpg/);
    expect(url).toContain('X-Amz-Signature=');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @garageos/api test:unit -- s3.test`
Expected: FAIL with TypeScript error "Property 'contentLength' is missing" — Compile-time fail, fine.

- [ ] **Step 3: Update `PresignedPutInput` type and implementation**

Replace in `packages/api/src/lib/s3.ts` (lines 30-54):

```ts
export interface PresignedPutInput {
  bucket: string;
  key: string;
  contentType: string;
  contentLength?: number;
  expiresInSeconds: number;
}

// presignPutObject signs a PUT URL with ContentType condition (always)
// and ContentLength condition (when provided). Clients MUST send those
// headers exactly when PUTting, otherwise S3 rejects.
//
// ContentLength is required for attachment flows (size known at upload-url
// time) but optional for avatar flow (Blob is generated client-side from
// canvas with variable size). Defense-in-depth for unknown-length: the
// deterministic per-user key + auth-gated endpoint prevent abuse.
export async function presignPutObject(input: PresignedPutInput): Promise<string> {
  try {
    const command = new PutObjectCommand({
      Bucket: input.bucket,
      Key: input.key,
      ContentType: input.contentType,
      ...(input.contentLength !== undefined ? { ContentLength: input.contentLength } : {}),
    });
    return await getSignedUrl(getS3Client(), command, { expiresIn: input.expiresInSeconds });
  } catch (cause) {
    throw new S3UnavailableError('Failed to sign presigned PUT URL', cause);
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --filter @garageos/api test:unit -- s3.test`
Expected: PASS all (existing tests + new one).

- [ ] **Step 5: Typecheck whole API**

Run: `pnpm --filter @garageos/api typecheck`
Expected: PASS — `attachments.ts` callers still typecheck because `contentLength` becomes optional (existing callers pass it, still valid).

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/lib/s3.ts packages/api/tests/unit/lib/s3.test.ts
git commit -m "refactor(api): make presignPutObject contentLength optional"
```

---

## Task 2: `avatar-presign.ts` helper + `serializeUserMe`

**Files:**
- Create: `packages/api/src/lib/avatar-presign.ts`
- Modify: `packages/api/src/lib/dtos/user-me.ts`
- Create: `packages/api/tests/unit/lib/avatar-presign.test.ts`

- [ ] **Step 1: Create `avatar-presign.ts`**

```ts
// packages/api/src/lib/avatar-presign.ts
import { env } from '../config/env.js';
import { S3UnavailableError, presignGetObject } from './s3.js';
import { businessError } from './business-error.js';

// Avatar presigned GET URL expiry. 15 minutes mirrors the attachment
// view-url flow (lib/attachments.ts). The web app caches /users/me via
// React Query with staleTime=5min, so URLs refresh well before expiry.
export const AVATAR_PRESIGN_EXPIRY_SECONDS = 900;

// Transforms a stored S3 key (e.g. 'avatars/users/<uuid>.jpg') into a
// short-lived presigned GET URL. Used by serializeUserMe to convert the
// DB-stored key into a wire-format URL.
//
// Maps S3UnavailableError → users.me.avatar.s3_unavailable (502); other
// errors bubble up to be handled as 500 by the global handler.
export async function keyToPresignedUrl(key: string): Promise<string> {
  try {
    return await presignGetObject({
      bucket: env.S3_ATTACHMENTS_BUCKET,
      key,
      expiresInSeconds: AVATAR_PRESIGN_EXPIRY_SECONDS,
    });
  } catch (err) {
    if (err instanceof S3UnavailableError) {
      throw businessError(
        'users.me.avatar.s3_unavailable',
        502,
        'Servizio storage temporaneamente non disponibile.',
      );
    }
    throw err;
  }
}
```

- [ ] **Step 2: Augment `user-me.ts` with `serializeUserMe`**

Update `packages/api/src/lib/dtos/user-me.ts` (replace entire file):

```ts
import type { Prisma } from '@garageos/database';

import { keyToPresignedUrl } from '../avatar-presign.js';

// Shared select for GET /v1/users/me + PATCH /v1/users/me response.
// Centralizing the projection eliminates drift between the two
// handlers. Field set choice rationale: same as the original GET
// handler — omits cognitoSub (security), deletedAt/updatedAt (internal
// churn), lastLoginAt (out of scope).
export const USER_ME_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  role: true,
  tenantId: true,
  locationId: true,
  avatarUrl: true,
  phone: true,
  status: true,
  createdAt: true,
} as const satisfies Prisma.UserSelect;

export type UserMeDto = Prisma.UserGetPayload<{ select: typeof USER_ME_SELECT }>;

// Wire-format DTO shape: `avatarUrl` semantics changes from DB-stored
// S3 key to a fully-resolved presigned GET URL (or null). This is the
// shape returned by every endpoint that exposes /users/me data.
export type UserMeWireDto = Omit<UserMeDto, 'avatarUrl'> & { avatarUrl: string | null };

// serializeUserMe transforms the DB row into the wire format by
// resolving avatarUrl (which is an S3 object key) into a presigned
// 15-min GET URL. Null when the user has no avatar set.
//
// Called by GET /v1/users/me, PATCH /v1/users/me, and
// POST /v1/users/me/avatar/confirm — anywhere the wire DTO is emitted.
export async function serializeUserMe(row: UserMeDto): Promise<UserMeWireDto> {
  const url = row.avatarUrl ? await keyToPresignedUrl(row.avatarUrl) : null;
  return { ...row, avatarUrl: url };
}
```

- [ ] **Step 3: Create unit test `avatar-presign.test.ts`**

```ts
// packages/api/tests/unit/lib/avatar-presign.test.ts
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _resetS3ClientForTests } from '../../../src/lib/s3.js';
import { keyToPresignedUrl } from '../../../src/lib/avatar-presign.js';
import { serializeUserMe } from '../../../src/lib/dtos/user-me.js';

const s3Mock = mockClient(S3Client);

beforeEach(() => {
  s3Mock.reset();
  _resetS3ClientForTests();
  s3Mock.on(GetObjectCommand).resolves({});
});

afterEach(() => {
  _resetS3ClientForTests();
});

describe('keyToPresignedUrl', () => {
  it('returns a presigned URL for the configured attachments bucket', async () => {
    const url = await keyToPresignedUrl('avatars/users/u1.jpg');
    expect(url).toMatch(/avatars\/users\/u1\.jpg/);
    expect(url).toContain('X-Amz-Signature=');
  });
});

describe('serializeUserMe', () => {
  const baseRow = {
    id: 'u1',
    email: 'a@b.c',
    firstName: 'A',
    lastName: 'B',
    role: 'mechanic' as const,
    tenantId: 't1',
    locationId: null,
    phone: null,
    status: 'active' as const,
    createdAt: new Date(),
  };

  it('returns avatarUrl=null when DB field is null', async () => {
    const out = await serializeUserMe({ ...baseRow, avatarUrl: null });
    expect(out.avatarUrl).toBeNull();
  });

  it('returns presigned URL when DB field has a key', async () => {
    const out = await serializeUserMe({ ...baseRow, avatarUrl: 'avatars/users/u1.jpg' });
    expect(out.avatarUrl).toMatch(/avatars\/users\/u1\.jpg/);
    expect(out.avatarUrl).toContain('X-Amz-Signature=');
  });
});
```

- [ ] **Step 4: Run unit tests**

Run: `pnpm --filter @garageos/api test:unit -- avatar-presign`
Expected: PASS all 3 tests.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @garageos/api typecheck`
Expected: PASS — note: this also propagates `serializeUserMe` to be available, but no caller uses it yet, so should still compile. Existing PATCH/GET handlers still return raw `UserMeDto` from Prisma (refactored in Task 3).

> Heads-up: `serializeUserMe` will be wired into `users.ts` and `users-update.ts` in Task 3. Until then, the handlers return the raw row with `avatarUrl` as S3 key. Existing integration tests for `/users/me` assert against fields that don't include `avatarUrl` content — verify by grep.

- [ ] **Step 6: Grep existing tests for assertions on `avatarUrl`**

Run via Grep tool: pattern `avatarUrl`, path `packages/api/tests`
Expected: zero hits (or only setup/select hits). If any test asserts on `avatarUrl` value, document and adjust in Task 3.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/lib/avatar-presign.ts packages/api/src/lib/dtos/user-me.ts packages/api/tests/unit/lib/avatar-presign.test.ts
git commit -m "feat(api): add keyToPresignedUrl + serializeUserMe for avatar"
```

---

## Task 3: Wire `serializeUserMe` into GET + PATCH `/users/me`

**Files:**
- Modify: `packages/api/src/routes/v1/users.ts`
- Modify: `packages/api/src/routes/v1/users-update.ts`

- [ ] **Step 1: Refactor `users.ts` GET handler**

Replace the handler in `packages/api/src/routes/v1/users.ts` (lines 31-49):

```ts
    async (request) => {
      const tenantId = request.tenantId!;
      const cognitoSub = request.userId!;

      return app.withContext({ tenantId }, async (tx) => {
        const row = await tx.user.findFirstOrThrow({
          where: { cognitoSub, tenantId },
          select: USER_ME_SELECT,
        });
        return serializeUserMe(row);
      });
    },
```

Add the import at the top:
```ts
import { USER_ME_SELECT, serializeUserMe } from '../../lib/dtos/user-me.js';
```

- [ ] **Step 2: Refactor `users-update.ts` PATCH handler**

In `packages/api/src/routes/v1/users-update.ts`, change the last `return tx.user.update(...)` (line 88) to:

```ts
        const updated = await tx.user.update({
          where: { id: existing.id },
          data: patch,
          select: USER_ME_SELECT,
        });
        return serializeUserMe(updated);
```

Add `serializeUserMe` to the import:
```ts
import { USER_ME_SELECT, serializeUserMe } from '../../lib/dtos/user-me.js';
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @garageos/api typecheck`
Expected: PASS.

- [ ] **Step 4: Verify no existing test assertion breaks**

Skip local integration test run per memoria `feedback_skip_local_integration_tests`. Rely on CI when push happens.

Manual inspection: in `packages/api/tests/integration/users-me.test.ts` and `packages/api/tests/integration/users-update.test.ts`, the assertions on `avatarUrl` (if any) will now compare against a presigned URL or `null` instead of a raw key. The pre-existing test fixtures create users without `avatarUrl` (null default), so the response field is `null` either way. Document if a test does set `avatarUrl` directly via DB helpers.

> If an existing test creates a user with `avatarUrl: 'something.jpg'` via `createUser`, after this task the response will be a presigned URL. Adjust asserts to use `expect(body.avatarUrl).toMatch(/something\.jpg/)` or similar.

Run grep over the test files:

Run: Grep `avatarUrl` in `packages/api/tests/integration/users-me.test.ts` and `users-update.test.ts`.
Expected: zero matches. If any, update.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/v1/users.ts packages/api/src/routes/v1/users-update.ts
git commit -m "refactor(api): wire serializeUserMe into GET+PATCH /users/me"
```

---

## Task 4: `POST /v1/users/me/avatar/upload-url` handler

**Files:**
- Create: `packages/api/src/routes/v1/users-avatar.ts` (initial — only upload-url handler)
- Modify: `packages/api/src/server.ts` (register plugin)

- [ ] **Step 1: Create the route file with upload-url handler**

```ts
// packages/api/src/routes/v1/users-avatar.ts
import type { FastifyPluginAsync } from 'fastify';

import { env } from '../../config/env.js';
import { businessError } from '../../lib/business-error.js';
import { AVATAR_PRESIGN_EXPIRY_SECONDS } from '../../lib/avatar-presign.js';
import { S3UnavailableError, presignPutObject } from '../../lib/s3.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';

// /v1/users/me/avatar/* — F-OFF-007 follow-up (slice L1).
//
// Three endpoints sharing the same auth + tenant-binding pattern:
//   POST   /upload-url  → issue presigned PUT for deterministic key
//   POST   /confirm     → HeadObject verify + UPDATE users.avatar_url
//   DELETE              → DeleteObject + UPDATE users.avatar_url=NULL
//
// Storage key is deterministic per user: `avatars/users/<userId>.jpg`.
// Output format is always JPEG (frontend resizes via canvas).
// Cross-tenant guard: findFirstOrThrow({ cognitoSub, tenantId }) before
// each operation — defense-in-depth post-#27 RLS split on users.

const PRESIGN_EXPIRY_SECONDS = AVATAR_PRESIGN_EXPIRY_SECONDS;

function avatarKey(userId: string): string {
  return `avatars/users/${userId}.jpg`;
}

const userAvatarRoutes: FastifyPluginAsync = async (app) => {
  // POST /v1/users/me/avatar/upload-url
  // Body: {} (empty). Mime is fixed server-side to image/jpeg because
  // the frontend always uploads canvas-encoded JPEG.
  app.post(
    '/v1/users/me/avatar/upload-url',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext],
    },
    async (request, reply) => {
      const tenantId = request.tenantId!;
      const cognitoSub = request.userId!;

      // Bind to (cognitoSub, tenantId) — defense in depth (see users.ts
      // for the full rationale).
      const user = await app.withContext({ tenantId }, (tx) =>
        tx.user.findFirstOrThrow({
          where: { cognitoSub, tenantId },
          select: { id: true },
        }),
      );

      const key = avatarKey(user.id);
      const bucket = env.S3_ATTACHMENTS_BUCKET;

      let uploadUrl: string;
      try {
        uploadUrl = await presignPutObject({
          bucket,
          key,
          contentType: 'image/jpeg',
          expiresInSeconds: PRESIGN_EXPIRY_SECONDS,
        });
      } catch (err) {
        if (err instanceof S3UnavailableError) {
          throw businessError(
            'users.me.avatar.s3_unavailable',
            502,
            'Servizio storage temporaneamente non disponibile.',
          );
        }
        throw err;
      }

      const expiresAt = new Date(Date.now() + PRESIGN_EXPIRY_SECONDS * 1000).toISOString();
      return reply.code(200).send({
        upload_url: uploadUrl,
        upload_method: 'PUT' as const,
        upload_headers: { 'Content-Type': 'image/jpeg' },
        expires_at: expiresAt,
      });
    },
  );
};

export default userAvatarRoutes;
```

- [ ] **Step 2: Register plugin in `server.ts`**

In `packages/api/src/server.ts`, add the import near other route imports:

```ts
import userAvatarRoutes from './routes/v1/users-avatar.js';
```

And register after `userUpdateRoutes` (around line 131):

```ts
  await app.register(userAvatarRoutes);
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @garageos/api typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/routes/v1/users-avatar.ts packages/api/src/server.ts
git commit -m "feat(api): POST /v1/users/me/avatar/upload-url"
```

---

## Task 5: `POST /v1/users/me/avatar/confirm` handler

**Files:**
- Modify: `packages/api/src/routes/v1/users-avatar.ts`

- [ ] **Step 1: Add confirm handler**

Append inside `userAvatarRoutes` plugin (after the upload-url handler closing brace):

```ts
  // POST /v1/users/me/avatar/confirm
  // Body: {}. Verifies the object landed on S3 via HeadObject
  // (mime must be image/jpeg) then flips users.avatar_url to the key.
  // Idempotent: re-calling with the same key produces the same result.
  app.post(
    '/v1/users/me/avatar/confirm',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext],
    },
    async (request, reply) => {
      const tenantId = request.tenantId!;
      const cognitoSub = request.userId!;

      const result = await app.withContext({ tenantId }, async (tx) => {
        const user = await tx.user.findFirstOrThrow({
          where: { cognitoSub, tenantId },
          select: { id: true },
        });

        const key = avatarKey(user.id);
        const bucket = env.S3_ATTACHMENTS_BUCKET;

        // HeadObject: verifies the object exists and matches mime. We
        // do NOT enforce content-length (Blob size is variable) — abuse
        // is mitigated by the deterministic per-user key and auth gate.
        let head: { contentLength: number; contentType: string };
        try {
          head = await headObject(bucket, key);
        } catch (err) {
          if (err instanceof S3ObjectNotFoundError) {
            throw businessError(
              'users.me.avatar.upload_not_found',
              422,
              "File non trovato su S3 — l'upload non è atterrato o è scaduto.",
            );
          }
          if (err instanceof S3UnavailableError) {
            throw businessError(
              'users.me.avatar.s3_unavailable',
              502,
              'Servizio storage temporaneamente non disponibile.',
            );
          }
          throw err;
        }

        if (head.contentType !== 'image/jpeg') {
          throw businessError(
            'users.me.avatar.invalid_mime',
            422,
            'Il file caricato deve essere JPEG.',
          );
        }

        const updated = await tx.user.update({
          where: { id: user.id },
          data: { avatarUrl: key },
          select: USER_ME_SELECT,
        });
        return serializeUserMe(updated);
      });

      return reply.code(200).send(result);
    },
  );
```

- [ ] **Step 2: Update imports**

Add to imports at top of `users-avatar.ts`:

```ts
import { S3ObjectNotFoundError, headObject } from '../../lib/s3.js';
import { USER_ME_SELECT, serializeUserMe } from '../../lib/dtos/user-me.js';
```

Update the existing `S3UnavailableError, presignPutObject` import line to keep `presignPutObject` and add `headObject` + `S3ObjectNotFoundError`. Final line:

```ts
import {
  S3ObjectNotFoundError,
  S3UnavailableError,
  headObject,
  presignPutObject,
} from '../../lib/s3.js';
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @garageos/api typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/routes/v1/users-avatar.ts
git commit -m "feat(api): POST /v1/users/me/avatar/confirm"
```

---

## Task 6: `DELETE /v1/users/me/avatar` handler

**Files:**
- Modify: `packages/api/src/routes/v1/users-avatar.ts`

- [ ] **Step 1: Add delete handler**

Append inside `userAvatarRoutes` plugin (after the confirm handler):

```ts
  // DELETE /v1/users/me/avatar
  // Removes avatar: best-effort DeleteObject on S3 + UPDATE
  // users.avatar_url = NULL. Idempotent: works whether avatar exists
  // or not. S3 delete failures are logged but do not fail the request
  // — the deterministic key means the orphaned object will be
  // overwritten on the next upload.
  app.delete(
    '/v1/users/me/avatar',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext],
    },
    async (request, reply) => {
      const tenantId = request.tenantId!;
      const cognitoSub = request.userId!;

      await app.withContext({ tenantId }, async (tx) => {
        const user = await tx.user.findFirstOrThrow({
          where: { cognitoSub, tenantId },
          select: { id: true },
        });

        const key = avatarKey(user.id);
        const bucket = env.S3_ATTACHMENTS_BUCKET;

        // Best-effort delete on S3. If it fails (network, eventual
        // consistency, key already absent), the request still succeeds
        // — the deterministic key means a future upload overwrites the
        // orphan.
        try {
          await getS3Client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        } catch (err) {
          request.log.warn({ err, key }, 'avatar S3 delete failed; ignoring');
        }

        await tx.user.update({
          where: { id: user.id },
          data: { avatarUrl: null },
        });
      });

      return reply.code(204).send();
    },
  );
```

- [ ] **Step 2: Update imports**

Add `DeleteObjectCommand` to the AWS SDK import (top of file). It is not currently imported; you need a separate line:

```ts
import { DeleteObjectCommand } from '@aws-sdk/client-s3';

import { getS3Client, S3ObjectNotFoundError, S3UnavailableError, headObject, presignPutObject } from '../../lib/s3.js';
```

Wait — `getS3Client` is exported from `lib/s3.ts` (see line 19 `export function getS3Client`). Add it to the import list.

Final imports block at top of `users-avatar.ts`:

```ts
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import type { FastifyPluginAsync } from 'fastify';

import { env } from '../../config/env.js';
import { AVATAR_PRESIGN_EXPIRY_SECONDS } from '../../lib/avatar-presign.js';
import { businessError } from '../../lib/business-error.js';
import { USER_ME_SELECT, serializeUserMe } from '../../lib/dtos/user-me.js';
import {
  S3ObjectNotFoundError,
  S3UnavailableError,
  getS3Client,
  headObject,
  presignPutObject,
} from '../../lib/s3.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @garageos/api typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/routes/v1/users-avatar.ts
git commit -m "feat(api): DELETE /v1/users/me/avatar"
```

---

## Task 7: Integration tests for avatar endpoints

**Files:**
- Create: `packages/api/tests/integration/users-me-avatar.test.ts`

- [ ] **Step 1: Create the test file**

```ts
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

function del(token: string, path: string) {
  return app.inject({
    method: 'DELETE',
    url: path,
    headers: { authorization: `Bearer ${token}` },
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
    expect(row.rows[0].avatar_url).toMatch(/^avatars\/users\/[a-f0-9-]+\.jpg$/);
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
    const k1 = r1.json().avatarUrl.match(/avatars\/users\/[a-f0-9-]+\.jpg/)[0];
    const k2 = r2.json().avatarUrl.match(/avatars\/users\/[a-f0-9-]+\.jpg/)[0];
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
    expect(seed.rows[0].avatar_url).not.toBeNull();

    // Now delete
    const res = await del(token, '/v1/users/me/avatar');
    expect(res.statusCode).toBe(204);

    const after = await pgAdmin.query<{ avatar_url: string | null }>(
      'SELECT avatar_url FROM users WHERE id = $1',
      [userId],
    );
    expect(after.rows[0].avatar_url).toBeNull();
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(1);
  });

  it('204: idempotent — DELETE when avatar already null', async () => {
    const { userId, token } = await setup('del-idem');
    const before = await pgAdmin.query<{ avatar_url: string | null }>(
      'SELECT avatar_url FROM users WHERE id = $1',
      [userId],
    );
    expect(before.rows[0].avatar_url).toBeNull();

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
    const keyA = ra.json().avatarUrl.match(/avatars\/users\/([a-f0-9-]+)\.jpg/)[1];
    const keyB = rb.json().avatarUrl.match(/avatars\/users\/([a-f0-9-]+)\.jpg/)[1];
    expect(keyA).not.toBe(keyB);
    expect(keyA).toBe(a.userId);
    expect(keyB).toBe(b.userId);
  });
});
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @garageos/api typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/api/tests/integration/users-me-avatar.test.ts
git commit -m "test(api): integration tests for avatar endpoints"
```

> CI will run the integration tests on push. Locally per memoria `feedback_skip_local_integration_tests`, do NOT run `pnpm test:integration` — let CI gate.

---

## Task 8: Docs — APPENDICE_A endpoints + APPENDICE_G error codes

**Files:**
- Modify: `docs/APPENDICE_A_API.md`
- Modify: `docs/APPENDICE_G_ERROR_CODES.md`

- [ ] **Step 1: Update APPENDICE_A — endpoints table**

In `docs/APPENDICE_A_API.md`, find the F-OFF-007 endpoints (around line 1364-1366 — was discovered earlier). Update the avatar row from "F-OFF-007" placeholder to expanded section. Replace:

```markdown
| POST | `/users/me/avatar` | F-OFF-007 | Tenant User | Upload avatar |
```

with the expanded 3-row block:

```markdown
| POST | `/users/me/avatar/upload-url` | F-OFF-007 | Tenant User | **[DETTAGLIATO sotto §3.4]** Genera presigned PUT URL per upload avatar |
| POST | `/users/me/avatar/confirm` | F-OFF-007 | Tenant User | **[DETTAGLIATO sotto §3.4]** Conferma upload S3 e flippa `avatar_url` |
| DELETE | `/users/me/avatar` | F-OFF-007 | Tenant User | **[DETTAGLIATO sotto §3.4]** Rimuove avatar (`avatar_url=NULL` + DeleteObject) |
```

- [ ] **Step 2: Append §3.4 dettaglio**

Search for the existing `§3.3 PATCH /users/me` detailed section in APPENDICE_A. Append after it a new section §3.4:

```markdown
#### §3.4 Avatar endpoints (`/users/me/avatar/*`)

Flusso 2-fase (analogo a `/attachments/upload-url` + `/confirm` di F-OFF-305 ma dedicato user-avatar, niente riga `attachments`):

**1. `POST /v1/users/me/avatar/upload-url`**

Restituisce un presigned PUT URL per la deterministic key `avatars/users/<user-id>.jpg`. Il client deve poi PUT-tare l'oggetto JPEG (output canvas client-side 512×512 ~85% quality) con header `Content-Type: image/jpeg` esatto.

Request body: `{}` (vuoto).

Response 200:
```json
{
  "upload_url": "https://<bucket>.s3.eu-central-1.amazonaws.com/avatars/users/<uuid>.jpg?...",
  "upload_method": "PUT",
  "upload_headers": { "Content-Type": "image/jpeg" },
  "expires_at": "2026-05-15T12:30:00Z"
}
```

Errori: `users.me.avatar.s3_unavailable` (502).

**2. `POST /v1/users/me/avatar/confirm`**

Verifica HeadObject (deve esistere e avere mime `image/jpeg`), poi flippa `users.avatar_url = '<key>'`. Idempotente.

Request body: `{}`.

Response 200: USER_ME response shape con `avatarUrl` come URL presigned 15-min.

Errori:
- `users.me.avatar.upload_not_found` (422) — HeadObject restituisce NoSuchKey
- `users.me.avatar.invalid_mime` (422) — HeadObject contentType ≠ `image/jpeg`
- `users.me.avatar.s3_unavailable` (502)

**3. `DELETE /v1/users/me/avatar`**

Best-effort `DeleteObject` su S3 + UPDATE `users SET avatar_url = NULL`. Idempotente (S3 failures loggate, request comunque 204).

Response 204 No Content.

**Note storage**:
- DB stora la S3 **key** (`avatars/users/<uuid>.jpg`), non l'URL.
- L'API layer trasforma key → presigned 15-min URL nel response di GET/PATCH/confirm.
- Riusa il bucket `S3_ATTACHMENTS_BUCKET` con prefix `avatars/users/`. Niente bucket pubblico.
- Output sempre JPEG: il frontend converte qualsiasi input (JPEG/PNG/WebP, max 5 MB) a JPEG 512×512 via canvas prima dell'upload.
```

- [ ] **Step 3: Update F-OFF-007 status flag**

Find in APPENDICE_A the F-OFF-007 status indicator (was 🟡 PARZIALE per PR #102). Update verso 🟢 IMPLEMENTATO se trovi un flag oggi parziale; altrimenti aggiungi una nota nel testo F-OFF-007 indicando che avatar è completato in slice L1.

- [ ] **Step 4: Update APPENDICE_G_ERROR_CODES**

In `docs/APPENDICE_G_ERROR_CODES.md`, trova la sezione utenti/profili (cerca per `users.me.update`). Aggiungi 3 nuove righe nella tabella (in ordine alfabetico secondo la convenzione del file):

```markdown
| `users.me.avatar.invalid_mime` | 422 | Il file caricato deve essere JPEG. | confirm avatar |
| `users.me.avatar.s3_unavailable` | 502 | Servizio storage temporaneamente non disponibile. | upload-url / confirm avatar |
| `users.me.avatar.upload_not_found` | 422 | File non trovato su S3 — l'upload non è atterrato o è scaduto. | confirm avatar |
```

> Adatta esattamente le colonne alla struttura esistente — APPENDICE_G usa colonne fisse (verifica leggendo le righe attorno).

- [ ] **Step 5: Commit**

```bash
git add docs/APPENDICE_A_API.md docs/APPENDICE_G_ERROR_CODES.md
git commit -m "docs: avatar endpoints + error codes (F-OFF-007 L1)"
```

---

## Task 9: Install `react-easy-crop` dep

**Files:**
- Modify: `packages/web/package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Install**

```bash
pnpm --filter @garageos/web add react-easy-crop
```

Expected: package.json updated with `"react-easy-crop": "^5.x"` in dependencies.

- [ ] **Step 2: Verify install + typecheck**

```bash
pnpm --filter @garageos/web typecheck
```

Expected: PASS — react-easy-crop ships with its own TS types.

- [ ] **Step 3: Commit**

```bash
git add packages/web/package.json pnpm-lock.yaml
git commit -m "build(web): add react-easy-crop dep"
```

---

## Task 10: `lib/initials.ts` util

**Files:**
- Create: `packages/web/src/lib/initials.ts`
- Create: `packages/web/src/lib/initials.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// packages/web/src/lib/initials.test.ts
import { describe, expect, it } from 'vitest';

import { getInitials } from './initials';

describe('getInitials', () => {
  it('returns first letter of firstName + first letter of lastName, uppercase', () => {
    expect(getInitials('mario', 'rossi')).toBe('MR');
  });

  it('handles already-uppercase input', () => {
    expect(getInitials('Mario', 'Rossi')).toBe('MR');
  });

  it('falls back to single letter when one name is empty', () => {
    expect(getInitials('Mario', '')).toBe('M');
    expect(getInitials('', 'Rossi')).toBe('R');
  });

  it('returns "?" when both empty', () => {
    expect(getInitials('', '')).toBe('?');
  });

  it('trims whitespace', () => {
    expect(getInitials('  Mario  ', ' Rossi ')).toBe('MR');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @garageos/web test -- initials`
Expected: FAIL — module not found.

- [ ] **Step 3: Create implementation**

```ts
// packages/web/src/lib/initials.ts

// getInitials returns the user's initials for fallback avatar display.
// "Mario", "Rossi" → "MR". Single name → single letter. Empty → "?".
export function getInitials(firstName: string, lastName: string): string {
  const f = firstName.trim();
  const l = lastName.trim();
  if (!f && !l) return '?';
  if (!f) return l[0]!.toUpperCase();
  if (!l) return f[0]!.toUpperCase();
  return (f[0]! + l[0]!).toUpperCase();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @garageos/web test -- initials`
Expected: PASS all 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/initials.ts packages/web/src/lib/initials.test.ts
git commit -m "feat(web): add getInitials util for avatar fallback"
```

---

## Task 11: `lib/avatarCanvas.ts` util

**Files:**
- Create: `packages/web/src/lib/avatarCanvas.ts`
- Create: `packages/web/src/lib/avatarCanvas.test.ts`

JSDOM doesn't support full canvas 2D rendering, so the test mocks `HTMLCanvasElement.prototype.toBlob` and `getContext` to assert call shape (parameters, output dimensions) rather than pixel-level correctness.

- [ ] **Step 1: Write failing test**

```ts
// packages/web/src/lib/avatarCanvas.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cropAndResize } from './avatarCanvas';

describe('cropAndResize', () => {
  const drawImageSpy = vi.fn();
  const toBlobSpy = vi.fn();

  beforeEach(() => {
    drawImageSpy.mockReset();
    toBlobSpy.mockReset();

    // Stub canvas.getContext
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      drawImage: drawImageSpy,
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;

    // Stub canvas.toBlob to invoke the callback with a fake Blob
    HTMLCanvasElement.prototype.toBlob = vi.fn(function (
      this: HTMLCanvasElement,
      callback: BlobCallback,
      type?: string,
      quality?: unknown,
    ) {
      toBlobSpy(type, quality);
      callback(new Blob(['fake'], { type: type ?? 'image/jpeg' }));
    }) as typeof HTMLCanvasElement.prototype.toBlob;

    // Stub Image load — fire onload synchronously next tick
    Object.defineProperty(global, 'Image', {
      writable: true,
      configurable: true,
      value: class {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        src = '';
        constructor() {
          queueMicrotask(() => this.onload?.());
        }
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('outputs JPEG blob at 512x512 with quality 0.85', async () => {
    const blob = await cropAndResize('blob:fake', { x: 0, y: 0, width: 100, height: 100 });
    expect(blob.type).toBe('image/jpeg');
    expect(toBlobSpy).toHaveBeenCalledWith('image/jpeg', 0.85);
  });

  it('calls drawImage with crop coords + 512px output size', async () => {
    await cropAndResize('blob:fake', { x: 10, y: 20, width: 100, height: 100 });
    expect(drawImageSpy).toHaveBeenCalledTimes(1);
    const call = drawImageSpy.mock.calls[0]!;
    // signature: (image, sx, sy, sw, sh, dx, dy, dw, dh)
    expect(call[1]).toBe(10);
    expect(call[2]).toBe(20);
    expect(call[3]).toBe(100);
    expect(call[4]).toBe(100);
    expect(call[5]).toBe(0);
    expect(call[6]).toBe(0);
    expect(call[7]).toBe(512);
    expect(call[8]).toBe(512);
  });

  it('accepts custom output size + quality', async () => {
    await cropAndResize('blob:fake', { x: 0, y: 0, width: 100, height: 100 }, 256, 0.7);
    expect(drawImageSpy.mock.calls[0]![7]).toBe(256);
    expect(toBlobSpy).toHaveBeenCalledWith('image/jpeg', 0.7);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @garageos/web test -- avatarCanvas`
Expected: FAIL — module not found.

- [ ] **Step 3: Create implementation**

```ts
// packages/web/src/lib/avatarCanvas.ts

export interface CropArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

// cropAndResize takes an image source URL (e.g. ObjectURL from a File),
// crops the specified pixel area, and re-encodes to JPEG at outputSize×outputSize.
// Used by AvatarCropDialog after react-easy-crop reports pixelCropArea.
//
// The output Blob is the body the client PUTs to S3 in the upload step.
// Sized for 512×512 JPEG ~85% quality → ~50-150 KB.
export async function cropAndResize(
  imageSrc: string,
  pixelCrop: CropArea,
  outputSize: number = 512,
  quality: number = 0.85,
): Promise<Blob> {
  const image = await loadImage(imageSrc);
  const canvas = document.createElement('canvas');
  canvas.width = outputSize;
  canvas.height = outputSize;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Canvas 2D context unavailable');
  }
  ctx.drawImage(
    image,
    pixelCrop.x,
    pixelCrop.y,
    pixelCrop.width,
    pixelCrop.height,
    0,
    0,
    outputSize,
    outputSize,
  );
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Canvas toBlob returned null'))),
      'image/jpeg',
      quality,
    );
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image load failed'));
    img.src = src;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @garageos/web test -- avatarCanvas`
Expected: PASS all 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/avatarCanvas.ts packages/web/src/lib/avatarCanvas.test.ts
git commit -m "feat(web): cropAndResize canvas util for avatar"
```

---

## Task 12: `queries/avatarUpload.ts` hook

**Files:**
- Create: `packages/web/src/queries/avatarUpload.ts`
- Create: `packages/web/src/queries/avatarUpload.test.tsx`

State machine: `idle → requesting → uploading(progress) → confirming → success | error`. XHR for upload progress.

- [ ] **Step 1: Read attachmentUpload pattern**

Skim `packages/web/src/queries/attachmentUpload.ts` (it's the reference). Avatar hook is similar but:
- No `interventionId` in scope (it's per-user)
- Step 1 body: `{}` instead of attachment payload
- Step 3 body: `{}`
- On success: invalidate `['users-me']` instead of `['intervention-detail', id]`

- [ ] **Step 2: Create the hook**

```tsx
// packages/web/src/queries/avatarUpload.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { useApiFetch, ApiError } from '@/lib/api-client';
import type { ProfileMeDto } from './profileMe';

// State machine for the 2-phase avatar upload.
// idle → requesting → uploading(progress) → confirming → success | error
export type AvatarUploadState =
  | { phase: 'idle' }
  | { phase: 'requesting' }
  | { phase: 'uploading'; progress: number }
  | { phase: 'confirming' }
  | { phase: 'success'; profile: ProfileMeDto }
  | { phase: 'error'; code: string; message: string };

interface UploadUrlResponse {
  upload_url: string;
  upload_method: 'PUT';
  upload_headers: Record<string, string>;
  expires_at: string;
}

export interface UseAvatarUploadResult {
  upload: (blob: Blob) => Promise<void>;
  remove: () => Promise<void>;
  state: AvatarUploadState;
  reset: () => void;
}

/**
 * Orchestrates the 2-phase S3 avatar upload protocol (slice L1).
 * Step 2 (PUT to S3) uses XMLHttpRequest for upload progress; fetch
 * cannot surface progress events. The XHR is held in a ref so an
 * unmount mid-flight aborts cleanly.
 *
 * Invalidates `['users-me']` on success so ProfileForm + TopBar
 * re-render with the fresh presigned URL.
 */
export function useAvatarUpload(): UseAvatarUploadResult {
  const apiFetch = useApiFetch();
  const queryClient = useQueryClient();
  const [state, setState] = useState<AvatarUploadState>({ phase: 'idle' });
  const xhrRef = useRef<XMLHttpRequest | null>(null);

  useEffect(() => {
    return () => {
      xhrRef.current?.abort();
    };
  }, []);

  const reset = useCallback(() => {
    setState({ phase: 'idle' });
  }, []);

  const upload = useCallback(
    async (blob: Blob) => {
      setState({ phase: 'requesting' });
      let presign: UploadUrlResponse;
      try {
        presign = await apiFetch<UploadUrlResponse>('/v1/users/me/avatar/upload-url', {
          method: 'POST',
          body: '{}',
        });
      } catch (e) {
        setState(toErrorState(e));
        return;
      }

      setState({ phase: 'uploading', progress: 0 });
      try {
        await putToS3(presign, blob, (progress) => {
          setState({ phase: 'uploading', progress });
        }, xhrRef);
      } catch (e) {
        setState(toErrorState(e));
        return;
      }

      setState({ phase: 'confirming' });
      try {
        const profile = await apiFetch<ProfileMeDto>('/v1/users/me/avatar/confirm', {
          method: 'POST',
          body: '{}',
        });
        setState({ phase: 'success', profile });
        await queryClient.invalidateQueries({ queryKey: ['users-me'] });
      } catch (e) {
        setState(toErrorState(e));
      }
    },
    [apiFetch, queryClient],
  );

  const remove = useCallback(async () => {
    setState({ phase: 'requesting' });
    try {
      await apiFetch<void>('/v1/users/me/avatar', { method: 'DELETE' });
      await queryClient.invalidateQueries({ queryKey: ['users-me'] });
      setState({ phase: 'idle' });
    } catch (e) {
      setState(toErrorState(e));
    }
  }, [apiFetch, queryClient]);

  return { upload, remove, state, reset };
}

function putToS3(
  presign: UploadUrlResponse,
  blob: Blob,
  onProgress: (progress: number) => void,
  xhrRef: React.MutableRefObject<XMLHttpRequest | null>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;
    xhr.open(presign.upload_method, presign.upload_url);
    for (const [k, v] of Object.entries(presign.upload_headers)) {
      xhr.setRequestHeader(k, v);
    }
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        onProgress(e.loaded / e.total);
      }
    };
    xhr.onload = () => {
      xhrRef.current = null;
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new XhrHttpError(xhr.status));
      }
    };
    xhr.onerror = () => {
      xhrRef.current = null;
      reject(new XhrNetworkError());
    };
    xhr.onabort = () => {
      xhrRef.current = null;
      reject(new XhrAbortError());
    };
    xhr.send(blob);
  });
}

class XhrHttpError extends Error {
  httpStatus: number;
  constructor(httpStatus: number) {
    super(`S3 PUT returned HTTP ${httpStatus}`);
    this.httpStatus = httpStatus;
  }
}
class XhrNetworkError extends Error {
  constructor() {
    super('S3 PUT network error');
  }
}
class XhrAbortError extends Error {
  constructor() {
    super('S3 PUT aborted');
  }
}

function toErrorState(e: unknown): { phase: 'error'; code: string; message: string } {
  if (e instanceof ApiError) {
    return { phase: 'error', code: e.code, message: e.message };
  }
  if (e instanceof XhrHttpError) {
    return { phase: 'error', code: 'xhr.http_error', message: `Upload fallito (HTTP ${e.httpStatus}).` };
  }
  if (e instanceof XhrNetworkError) {
    return { phase: 'error', code: 'xhr.network_error', message: "Errore di rete durante l'upload." };
  }
  if (e instanceof XhrAbortError) {
    return { phase: 'error', code: 'xhr.aborted', message: 'Upload interrotto.' };
  }
  const message = e instanceof Error ? e.message : 'Errore sconosciuto';
  return { phase: 'error', code: 'unknown', message };
}
```

- [ ] **Step 3: Create the test file**

```tsx
// packages/web/src/queries/avatarUpload.test.tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAvatarUpload } from './avatarUpload';

// Mock useApiFetch
const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>('@/lib/api-client');
  return {
    ...actual,
    useApiFetch: () => apiFetchMock,
  };
});

// Mock XMLHttpRequest
class FakeXHR {
  upload = { onprogress: null as ((e: ProgressEvent) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 200;
  open = vi.fn();
  setRequestHeader = vi.fn();
  abort = vi.fn(() => {
    this.onabort?.();
  });
  send = vi.fn(() => {
    queueMicrotask(() => {
      this.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 } as ProgressEvent);
      this.upload.onprogress?.({ lengthComputable: true, loaded: 100, total: 100 } as ProgressEvent);
      this.onload?.();
    });
  });
}

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  apiFetchMock.mockReset();
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useAvatarUpload', () => {
  it('happy path: idle → requesting → uploading → confirming → success', async () => {
    apiFetchMock
      .mockResolvedValueOnce({
        upload_url: 'https://s3.test/key',
        upload_method: 'PUT',
        upload_headers: { 'Content-Type': 'image/jpeg' },
        expires_at: 'x',
      })
      .mockResolvedValueOnce({ id: 'u1', avatarUrl: 'https://signed' });

    const { result } = renderHook(() => useAvatarUpload(), { wrapper });
    expect(result.current.state.phase).toBe('idle');

    const blob = new Blob(['x'], { type: 'image/jpeg' });
    await act(async () => {
      await result.current.upload(blob);
    });

    await waitFor(() => expect(result.current.state.phase).toBe('success'));
  });

  it('upload-url failure transitions to error state', async () => {
    apiFetchMock.mockRejectedValueOnce(
      Object.assign(new Error('boom'), { name: 'ApiError', code: 'users.me.avatar.s3_unavailable', status: 502 }),
    );
    const { result } = renderHook(() => useAvatarUpload(), { wrapper });
    await act(async () => {
      await result.current.upload(new Blob());
    });
    expect(result.current.state.phase).toBe('error');
  });

  it('remove: DELETE success → idle', async () => {
    apiFetchMock.mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useAvatarUpload(), { wrapper });
    await act(async () => {
      await result.current.remove();
    });
    expect(result.current.state.phase).toBe('idle');
  });

  it('reset resets to idle from any state', async () => {
    const { result } = renderHook(() => useAvatarUpload(), { wrapper });
    apiFetchMock.mockRejectedValueOnce(new Error('boom'));
    await act(async () => {
      await result.current.upload(new Blob());
    });
    expect(result.current.state.phase).toBe('error');
    act(() => {
      result.current.reset();
    });
    expect(result.current.state.phase).toBe('idle');
  });
});
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @garageos/web test -- avatarUpload`
Expected: PASS all 4 tests.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @garageos/web typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/queries/avatarUpload.ts packages/web/src/queries/avatarUpload.test.tsx
git commit -m "feat(web): useAvatarUpload hook with state machine"
```

---

## Task 13: `AvatarCropDialog` component

**Files:**
- Create: `packages/web/src/components/settings/AvatarCropDialog.tsx`
- Create: `packages/web/src/components/settings/AvatarCropDialog.test.tsx`

shadcn `Dialog` should already be available (used by Slice J EditDialog). Verify import path `@/components/ui/dialog`.

- [ ] **Step 1: Verify shadcn Dialog exists**

Run: Glob `packages/web/src/components/ui/dialog.tsx`
Expected: exists.

If absent, install via shadcn CLI:
```bash
cd packages/web && pnpm dlx shadcn@latest add dialog
```
Per memoria `feedback_shadcn_cli_literal_alias_path`: post-add, verify nessuna directory literale `packages/web/@/` creata; se sì, sposta i file e cancellala.

- [ ] **Step 2: Create the component**

```tsx
// packages/web/src/components/settings/AvatarCropDialog.tsx
import { useState, useCallback } from 'react';
import Cropper from 'react-easy-crop';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cropAndResize, type CropArea } from '@/lib/avatarCanvas';

interface Props {
  open: boolean;
  imageSrc: string | null;
  onCancel: () => void;
  onConfirm: (blob: Blob) => void;
}

// AvatarCropDialog wraps react-easy-crop in a shadcn Dialog. The user
// drags + zooms; on confirm, the pixel coords are passed to cropAndResize
// which produces a 512×512 JPEG Blob ready to upload to S3.
//
// onConfirm runs synchronously once the Blob is generated. Upload
// orchestration lives in the parent (AvatarSection → useAvatarUpload).
export function AvatarCropDialog({ open, imageSrc, onCancel, onConfirm }: Props) {
  const [crop, setCrop] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [pixelCrop, setPixelCrop] = useState<CropArea | null>(null);
  const [busy, setBusy] = useState(false);

  const handleCropComplete = useCallback((_: unknown, area: CropArea) => {
    setPixelCrop(area);
  }, []);

  async function handleConfirm() {
    if (!imageSrc || !pixelCrop) return;
    setBusy(true);
    try {
      const blob = await cropAndResize(imageSrc, pixelCrop);
      onConfirm(blob);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Ritaglia foto</DialogTitle>
        </DialogHeader>
        <div className="relative w-full h-80 bg-muted">
          {imageSrc && (
            <Cropper
              image={imageSrc}
              crop={crop}
              zoom={zoom}
              aspect={1}
              cropShape="round"
              onCropChange={setCrop}
              onZoomChange={setZoom}
              onCropComplete={handleCropComplete}
            />
          )}
        </div>
        <div className="px-1 py-2">
          <label htmlFor="zoom" className="text-xs text-muted-foreground">
            Zoom
          </label>
          <input
            id="zoom"
            type="range"
            min={1}
            max={3}
            step={0.1}
            value={zoom}
            onChange={(e) => setZoom(parseFloat(e.target.value))}
            className="w-full"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            Annulla
          </Button>
          <Button onClick={handleConfirm} disabled={busy || !pixelCrop}>
            {busy ? 'Elaborando...' : 'Conferma'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 3: Create the test**

Note: react-easy-crop uses pointer events + ResizeObserver, both flaky in JSDOM. The test focuses on the orchestration around `onCropComplete` (simulate via direct call) and the confirm flow.

```tsx
// packages/web/src/components/settings/AvatarCropDialog.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AvatarCropDialog } from './AvatarCropDialog';

// Mock react-easy-crop: render a simple div + an onCropComplete trigger button
vi.mock('react-easy-crop', () => ({
  default: ({
    onCropComplete,
  }: {
    onCropComplete: (
      _: unknown,
      area: { x: number; y: number; width: number; height: number },
    ) => void;
  }) => (
    <div>
      <button
        type="button"
        data-testid="sim-crop"
        onClick={() => onCropComplete({}, { x: 10, y: 20, width: 100, height: 100 })}
      >
        sim
      </button>
    </div>
  ),
}));

// Mock avatarCanvas.cropAndResize to avoid real canvas
vi.mock('@/lib/avatarCanvas', () => ({
  cropAndResize: vi.fn(async () => new Blob(['x'], { type: 'image/jpeg' })),
}));

const onCancel = vi.fn();
const onConfirm = vi.fn();

beforeEach(() => {
  onCancel.mockReset();
  onConfirm.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('AvatarCropDialog', () => {
  it('renders title when open', () => {
    render(
      <AvatarCropDialog open imageSrc="blob:test" onCancel={onCancel} onConfirm={onConfirm} />,
    );
    expect(screen.getByText('Ritaglia foto')).toBeInTheDocument();
  });

  it('Annulla button calls onCancel', async () => {
    const user = userEvent.setup();
    render(
      <AvatarCropDialog open imageSrc="blob:test" onCancel={onCancel} onConfirm={onConfirm} />,
    );
    await user.click(screen.getByRole('button', { name: 'Annulla' }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('Conferma is disabled until crop is reported', async () => {
    render(
      <AvatarCropDialog open imageSrc="blob:test" onCancel={onCancel} onConfirm={onConfirm} />,
    );
    expect(screen.getByRole('button', { name: 'Conferma' })).toBeDisabled();
  });

  it('Conferma after crop calls cropAndResize and onConfirm with Blob', async () => {
    const user = userEvent.setup();
    render(
      <AvatarCropDialog open imageSrc="blob:test" onCancel={onCancel} onConfirm={onConfirm} />,
    );
    // Trigger the mocked onCropComplete
    await user.click(screen.getByTestId('sim-crop'));
    await user.click(screen.getByRole('button', { name: 'Conferma' }));
    // The mock returns immediately; wait for the call
    await new Promise((r) => queueMicrotask(r as () => void));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0]![0]).toBeInstanceOf(Blob);
  });
});
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @garageos/web test -- AvatarCropDialog`
Expected: PASS all 4 tests.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @garageos/web typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/settings/AvatarCropDialog.tsx packages/web/src/components/settings/AvatarCropDialog.test.tsx
git commit -m "feat(web): AvatarCropDialog with react-easy-crop"
```

---

## Task 14: `AvatarSection` component + ProfileForm integration

**Files:**
- Create: `packages/web/src/components/settings/AvatarSection.tsx`
- Create: `packages/web/src/components/settings/AvatarSection.test.tsx`
- Modify: `packages/web/src/components/settings/ProfileForm.tsx`

- [ ] **Step 1: Verify shadcn AlertDialog exists**

Run: Glob `packages/web/src/components/ui/alert-dialog.tsx`
Expected: exists (added in slice L).

- [ ] **Step 2: Create the AvatarSection component**

```tsx
// packages/web/src/components/settings/AvatarSection.tsx
import { useRef, useState } from 'react';
import { toast } from 'sonner';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { getInitials } from '@/lib/initials';
import type { ProfileMeDto } from '@/queries/profileMe';
import { useAvatarUpload } from '@/queries/avatarUpload';
import { AvatarCropDialog } from './AvatarCropDialog';

const ACCEPTED_MIMES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_SIZE_BYTES = 5 * 1024 * 1024;

interface Props {
  profile: ProfileMeDto;
}

// AvatarSection renders the current avatar (or initials fallback),
// a "Cambia foto" button (file picker → crop dialog → upload), and
// a "Rimuovi" button (with AlertDialog confirmation) when an avatar
// is already set. State machine + S3 orchestration lives in
// useAvatarUpload — this component is presentation + glue.
export function AvatarSection({ profile }: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [cropOpen, setCropOpen] = useState(false);
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const { upload, remove, state, reset } = useAvatarUpload();

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // reset so selecting the same file twice retriggers
    if (!file) return;

    if (!ACCEPTED_MIMES.includes(file.type)) {
      toast.error('Formato non supportato. Usa JPEG, PNG o WebP.');
      return;
    }
    if (file.size > MAX_SIZE_BYTES) {
      toast.error('File troppo grande. Massimo 5 MB.');
      return;
    }

    const url = URL.createObjectURL(file);
    setImageSrc(url);
    setCropOpen(true);
  }

  async function handleCropConfirm(blob: Blob) {
    setCropOpen(false);
    if (imageSrc) {
      URL.revokeObjectURL(imageSrc);
      setImageSrc(null);
    }
    await upload(blob);
    if (state.phase === 'error') {
      toast.error(state.message);
    } else {
      toast.success('Foto profilo aggiornata.');
    }
    reset();
  }

  function handleCropCancel() {
    setCropOpen(false);
    if (imageSrc) {
      URL.revokeObjectURL(imageSrc);
      setImageSrc(null);
    }
  }

  async function handleRemoveConfirm() {
    setRemoveOpen(false);
    await remove();
    if (state.phase === 'error') {
      toast.error(state.message);
    } else {
      toast.success('Foto profilo rimossa.');
    }
    reset();
  }

  const initials = getInitials(profile.firstName, profile.lastName);
  const isBusy =
    state.phase === 'requesting' || state.phase === 'uploading' || state.phase === 'confirming';

  return (
    <div className="flex items-center gap-4 mb-6">
      {profile.avatarUrl ? (
        <img
          src={profile.avatarUrl}
          alt="Foto profilo"
          className="w-24 h-24 rounded-full object-cover bg-muted"
        />
      ) : (
        <div
          aria-label="Iniziali profilo"
          className="w-24 h-24 rounded-full bg-muted flex items-center justify-center text-2xl font-semibold"
        >
          {initials}
        </div>
      )}
      <div className="space-y-2">
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          hidden
          onChange={handleFileSelect}
          data-testid="avatar-file-input"
        />
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => inputRef.current?.click()}
            disabled={isBusy}
          >
            {isBusy ? 'Caricamento...' : 'Cambia foto'}
          </Button>
          {profile.avatarUrl && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => setRemoveOpen(true)}
              disabled={isBusy}
            >
              Rimuovi
            </Button>
          )}
        </div>
        {state.phase === 'uploading' && (
          <div className="text-xs text-muted-foreground">
            Caricamento: {Math.round(state.progress * 100)}%
          </div>
        )}
      </div>

      <AvatarCropDialog
        open={cropOpen}
        imageSrc={imageSrc}
        onCancel={handleCropCancel}
        onConfirm={handleCropConfirm}
      />

      <AlertDialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rimuovere foto profilo?</AlertDialogTitle>
            <AlertDialogDescription>
              La foto verrà eliminata. Tornerai alle iniziali come fallback.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annulla</AlertDialogCancel>
            <AlertDialogAction onClick={handleRemoveConfirm}>Sì, rimuovi</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
```

- [ ] **Step 3: Integrate into ProfileForm**

In `packages/web/src/components/settings/ProfileForm.tsx`, add at the top of the return JSX (above the form, since AvatarSection has its own state):

Replace:
```tsx
  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 max-w-xl">
```

with:
```tsx
  return (
    <div className="max-w-xl">
      <AvatarSection profile={profile} />
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
```

And close at the end — find the last `</form>` and replace with:
```tsx
      </form>
    </div>
```

Add the import at the top:
```tsx
import { AvatarSection } from './AvatarSection';
```

- [ ] **Step 4: Create AvatarSection test**

```tsx
// packages/web/src/components/settings/AvatarSection.test.tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AvatarSection } from './AvatarSection';
import type { ProfileMeDto } from '@/queries/profileMe';

// Mock toast
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

// Mock the hook
const uploadMock = vi.fn();
const removeMock = vi.fn();
const resetMock = vi.fn();
const hookStateRef = { current: { phase: 'idle' as const } };
vi.mock('@/queries/avatarUpload', () => ({
  useAvatarUpload: () => ({
    upload: uploadMock,
    remove: removeMock,
    reset: resetMock,
    get state() {
      return hookStateRef.current;
    },
  }),
}));

// Mock crop dialog — render a button that fires onConfirm with a Blob
vi.mock('./AvatarCropDialog', () => ({
  AvatarCropDialog: ({ open, onConfirm }: { open: boolean; onConfirm: (b: Blob) => void }) =>
    open ? (
      <button data-testid="sim-crop-confirm" onClick={() => onConfirm(new Blob(['x']))}>
        sim-crop-confirm
      </button>
    ) : null,
}));

const baseProfile: ProfileMeDto = {
  id: 'u1',
  email: 'a@b.c',
  firstName: 'Mario',
  lastName: 'Rossi',
  role: 'mechanic',
  tenantId: 't1',
  locationId: null,
  avatarUrl: null,
  phone: null,
  status: 'active',
  createdAt: '2026-01-01T00:00:00Z',
};

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  uploadMock.mockReset();
  removeMock.mockReset();
  hookStateRef.current = { phase: 'idle' };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('AvatarSection', () => {
  it('renders initials when avatarUrl is null', () => {
    render(<AvatarSection profile={baseProfile} />, { wrapper });
    expect(screen.getByLabelText('Iniziali profilo')).toHaveTextContent('MR');
  });

  it('renders <img> when avatarUrl is set', () => {
    render(<AvatarSection profile={{ ...baseProfile, avatarUrl: 'https://signed' }} />, {
      wrapper,
    });
    expect(screen.getByAltText('Foto profilo')).toHaveAttribute('src', 'https://signed');
  });

  it('does NOT render Rimuovi button when no avatar', () => {
    render(<AvatarSection profile={baseProfile} />, { wrapper });
    expect(screen.queryByRole('button', { name: 'Rimuovi' })).not.toBeInTheDocument();
  });

  it('renders Rimuovi button when avatar present', () => {
    render(<AvatarSection profile={{ ...baseProfile, avatarUrl: 'https://signed' }} />, {
      wrapper,
    });
    expect(screen.getByRole('button', { name: 'Rimuovi' })).toBeInTheDocument();
  });

  it('file picker → invalid mime → toast error, hook NOT called', async () => {
    const { toast } = await import('sonner');
    render(<AvatarSection profile={baseProfile} />, { wrapper });
    const input = screen.getByTestId('avatar-file-input') as HTMLInputElement;
    const badFile = new File(['x'], 'a.txt', { type: 'text/plain' });
    await userEvent.upload(input, badFile);
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringMatching(/Formato non supportato/),
    );
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('file picker → oversized → toast error', async () => {
    const { toast } = await import('sonner');
    render(<AvatarSection profile={baseProfile} />, { wrapper });
    const input = screen.getByTestId('avatar-file-input') as HTMLInputElement;
    const bigFile = new File([new Uint8Array(6 * 1024 * 1024)], 'a.jpg', { type: 'image/jpeg' });
    await userEvent.upload(input, bigFile);
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/troppo grande/));
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('file picker → valid → opens crop dialog → confirm calls upload', async () => {
    render(<AvatarSection profile={baseProfile} />, { wrapper });
    const input = screen.getByTestId('avatar-file-input') as HTMLInputElement;
    const goodFile = new File(['x'], 'a.jpg', { type: 'image/jpeg' });
    await userEvent.upload(input, goodFile);
    // crop dialog now open (mock renders sim-crop-confirm)
    const simButton = await screen.findByTestId('sim-crop-confirm');
    await userEvent.click(simButton);
    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(uploadMock.mock.calls[0]![0]).toBeInstanceOf(Blob);
  });

  it('Rimuovi → AlertDialog → conferma calls remove', async () => {
    render(<AvatarSection profile={{ ...baseProfile, avatarUrl: 'https://signed' }} />, {
      wrapper,
    });
    await userEvent.click(screen.getByRole('button', { name: 'Rimuovi' }));
    await userEvent.click(screen.getByRole('button', { name: 'Sì, rimuovi' }));
    expect(removeMock).toHaveBeenCalled();
  });

  it('renders upload progress when phase=uploading', () => {
    hookStateRef.current = { phase: 'uploading', progress: 0.42 } as never;
    render(<AvatarSection profile={baseProfile} />, { wrapper });
    expect(screen.getByText(/Caricamento: 42%/)).toBeInTheDocument();
  });
});
```

> Nota su `userEvent.click` su componenti shadcn (vedi memoria `feedback_radix_tabs_user_event_not_fire_event`): Radix Dialog/AlertDialog richiede `userEvent` (non `fireEvent`) per triggerare onValueChange/click. I test sopra usano già `userEvent`.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @garageos/web test -- AvatarSection`
Expected: PASS all 8 tests.

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @garageos/web typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/components/settings/AvatarSection.tsx packages/web/src/components/settings/AvatarSection.test.tsx packages/web/src/components/settings/ProfileForm.tsx
git commit -m "feat(web): AvatarSection with crop+remove flow in ProfileForm"
```

---

## Task 15: TopBar avatar display

**Files:**
- Modify: `packages/web/src/components/layout/TopBar.tsx`
- Create: `packages/web/src/components/layout/TopBar.test.tsx`

- [ ] **Step 1: Check if TopBar.test.tsx already exists**

Run: Glob `packages/web/src/components/layout/TopBar.test.tsx`
Expected: not present (slice L did not test TopBar). New file.

- [ ] **Step 2: Update TopBar**

Replace the entire content of `packages/web/src/components/layout/TopBar.tsx`:

```tsx
import { ChevronDown, LogOut } from 'lucide-react';

import { useAuth } from '@/auth/useAuth';
import { getInitials } from '@/lib/initials';
import { useProfileMe } from '@/queries/profileMe';
import { ThemeToggle } from '@/theme/ThemeToggle';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

// TopBar shows the brand strip + user menu (avatar / email + signOut).
// Avatar comes from useProfileMe (already cached by ProfileForm); when
// absent or loading, fallback to initials computed from the user's
// firstName / lastName. Email always shown next to avatar/initials.
export function TopBar() {
  const { state, signOut } = useAuth();
  const profileQuery = useProfileMe();

  const authedEmail = state.status === 'authenticated' ? state.user.email : '';
  const profile = profileQuery.data;
  const avatarUrl = profile?.avatarUrl ?? null;
  const initials = profile ? getInitials(profile.firstName, profile.lastName) : '?';

  return (
    <header className="bg-card border-b border-border px-6 py-3 flex items-center justify-between">
      <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
        Officina Bootstrap
      </div>
      <div className="flex items-center gap-2">
        <ThemeToggle />
        <DropdownMenu>
          <DropdownMenuTrigger className="flex items-center gap-2 text-sm text-foreground hover:opacity-80 transition">
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt=""
                className="w-8 h-8 rounded-full object-cover bg-muted"
                data-testid="topbar-avatar-img"
              />
            ) : (
              <div
                className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-xs font-semibold"
                data-testid="topbar-avatar-initials"
              >
                {initials}
              </div>
            )}
            <span>{authedEmail}</span>
            <ChevronDown size={14} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={signOut}>
              <LogOut size={14} className="mr-2" /> Esci
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
```

- [ ] **Step 3: Create TopBar test**

```tsx
// packages/web/src/components/layout/TopBar.test.tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TopBar } from './TopBar';

// Mock useAuth
vi.mock('@/auth/useAuth', () => ({
  useAuth: () => ({
    state: { status: 'authenticated', user: { email: 'mario@officina.it' } },
    signOut: vi.fn(),
  }),
}));

// Mock ThemeToggle (irrelevant for this test)
vi.mock('@/theme/ThemeToggle', () => ({
  ThemeToggle: () => <button type="button">theme</button>,
}));

// Per-test override of useProfileMe
const profileQueryRef = { current: { data: undefined as unknown } };
vi.mock('@/queries/profileMe', () => ({
  useProfileMe: () => profileQueryRef.current,
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('TopBar', () => {
  it('renders avatar img when profile.avatarUrl present', () => {
    profileQueryRef.current = {
      data: {
        firstName: 'Mario',
        lastName: 'Rossi',
        avatarUrl: 'https://signed-url',
      },
    };
    render(<TopBar />, { wrapper });
    const img = screen.getByTestId('topbar-avatar-img') as HTMLImageElement;
    expect(img).toBeInTheDocument();
    expect(img.src).toBe('https://signed-url/');
  });

  it('renders initials fallback when avatarUrl is null', () => {
    profileQueryRef.current = {
      data: { firstName: 'Mario', lastName: 'Rossi', avatarUrl: null },
    };
    render(<TopBar />, { wrapper });
    expect(screen.getByTestId('topbar-avatar-initials')).toHaveTextContent('MR');
  });

  it('renders ? initials when profile not yet loaded', () => {
    profileQueryRef.current = { data: undefined };
    render(<TopBar />, { wrapper });
    expect(screen.getByTestId('topbar-avatar-initials')).toHaveTextContent('?');
  });

  it('renders email next to avatar', () => {
    profileQueryRef.current = {
      data: { firstName: 'Mario', lastName: 'Rossi', avatarUrl: null },
    };
    render(<TopBar />, { wrapper });
    expect(screen.getByText('mario@officina.it')).toBeInTheDocument();
  });
});
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @garageos/web test -- TopBar`
Expected: PASS all 4 tests.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @garageos/web typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/layout/TopBar.tsx packages/web/src/components/layout/TopBar.test.tsx
git commit -m "feat(web): TopBar shows user avatar with initials fallback"
```

---

## Task 16: Final validation + push

**Files:** none (validation only)

- [ ] **Step 1: Typecheck all packages**

```bash
pnpm -r typecheck
```

Expected: PASS — this is the husky pre-push gate. Per memoria `feedback_skip_local_integration_tests` non lanciare test:integration o test:unit locale.

- [ ] **Step 2: Review diff size**

```bash
git diff --stat main...HEAD
```

Expected: ~1300 LOC across ~16 file. Under 1500 hard limit. Documenta in PR description se vicino.

- [ ] **Step 3: Push branch**

```bash
git push -u origin feat/avatar-upload
```

Expected: husky pre-push runs `pnpm -r typecheck`, then push succeeds. CI starts.

- [ ] **Step 4: Watch CI**

```bash
gh pr create --base main --title "feat(api,web): F-OFF-007 L1 avatar upload (S3 presigned + crop UI)" --body-file - <<'EOF'
## What

Slice L1 of F-OFF-007: utenti possono caricare/ritagliare/rimuovere la foto profilo.

## Why

Spec: docs/superpowers/specs/2026-05-15-l1-avatar-upload-design.md
F-OFF-007 ("Profilo utente — nome, foto, password"); avatar è il primo dei due tasselli mancanti dopo PR #102 (slice L profile self-edit).

## Implementation notes

- 3 nuovi endpoint dedicati `/v1/users/me/avatar/{upload-url,confirm,DELETE}` — niente riga `attachments` (avatar è single-value per user).
- Storage privato: bucket attachment esistente, prefix `avatars/users/`, key deterministica `avatars/users/<user-id>.jpg` (overwrite implicit).
- DB stora la S3 **key**; serializer `serializeUserMe` trasforma key → presigned GET URL 15-min nel response.
- Frontend: crop UI con `react-easy-crop` (1:1, output JPEG 512×512 ~85% via canvas), avatar widget in ProfileForm + TopBar (fallback iniziali).
- `presignPutObject` refactored per accettare `contentLength` optional (Blob size variabile lato canvas).

## Tests

- [x] Unit tests added (s3.test, avatar-presign.test, initials.test, avatarCanvas.test, avatarUpload.test, AvatarCropDialog.test, AvatarSection.test, TopBar.test)
- [x] Integration tests added (users-me-avatar.test)
- [x] BR rules verified: none — F-OFF-007 non ha BR codificate
- [ ] Manual smoke (post-deploy): see runbook in PR comment

## Checklist

- [x] Types compile (`pnpm -r typecheck`)
- [x] Documentation updated (APPENDICE_A §3.4 + APPENDICE_G 3 error codes)
- [x] Secrets not committed
EOF
gh pr checks --watch
```

Expected: tutti i check verdi.

- [ ] **Step 5: Post-PR smoke runbook (operator)**

Quando CI verde + deploy production triggered:

1. Login super_admin → /settings → tab Profilo
2. "Cambia foto" → seleziona JPEG ~2 MB → crop+zoom → Conferma
3. Verifica: avatar appare in ProfileForm 96px + TopBar 32px
4. Reload pagina → persistente
5. F12 → Network tab → GET /v1/users/me → response.avatarUrl è URL S3 presigned (non raw key)
6. "Rimuovi" → AlertDialog conferma → torna a iniziali; reload → persistente
7. Repeat con mechanic-test@demo-giuseppe.test
8. Edge: upload PNG → crop OK → output JPEG; upload 6 MB → frontend block prima del crop

---

## Self-review checklist

Eseguito a fine plan-write per verificare consistency tra task.

**1. Spec coverage:**
- ✅ Storage privato + presigned GET → Task 2 (serializeUserMe) + Task 4 (upload-url) + Task 5 (confirm)
- ✅ Crop UX 512×512 JPEG → Task 11 (avatarCanvas) + Task 13 (CropDialog)
- ✅ API 2-phase dedicated → Task 4 + 5 + 6
- ✅ UI ProfileForm + TopBar → Task 14 + 15
- ✅ Input JPEG/PNG/WebP ≤ 5 MB → Task 14 (AvatarSection validation)
- ✅ DELETE idempotente → Task 6 + Task 7 integration tests
- ✅ Mime fissato server-side `image/jpeg` → Task 4 hardcoded contentType
- ✅ contentLength optional → Task 1
- ✅ APPENDICE_A 3 endpoint + APPENDICE_G 3 error codes → Task 8
- ✅ Cross-tenant defense-in-depth → Task 7 integration test
- ✅ Tests strategy → Task 2, 7, 10, 11, 12, 13, 14, 15

**2. Type consistency:**
- ✅ `serializeUserMe` async signature usata in Task 2 + Task 3 + Task 5 — coerente
- ✅ `UserMeWireDto` definito in Task 2 — non riferito esternamente fuori dai task, OK
- ✅ `AvatarUploadState` definito in Task 12 — consumato in Task 14 test via state.phase — coerente
- ✅ `CropArea` definito in Task 11 — importato in Task 13 — coerente
- ✅ `getInitials(firstName, lastName)` signature in Task 10 — chiamato in Task 14 + 15 con stessi parametri — coerente
- ✅ `cropAndResize(imageSrc, pixelCrop, outputSize, quality)` signature in Task 11 — chiamato in Task 13 con `(imageSrc, pixelCrop)` (default arg) — coerente

**3. Placeholder scan:**
- Nessun TBD / TODO / "implement later". 
- Tutte le step contengono codice completo o comandi specifici.

**4. Edge case nel test JSDOM**:
- `userEvent.click` su Radix AlertDialog (lesson #102 T12) — usato in Task 14 ✓
- `aws-sdk-client-mock` non intercetta presigner (lesson #52) — settato `AWS_ACCESS_KEY_ID ??=` in Task 7 ✓
- shadcn CLI literal alias bug (lesson #102 T6) — segnalato in Task 13 ✓

---

## Lessons applied

- `feedback_middleware_throw_fastifyerror_not_reply_send` (PR #102 T1): `businessError` helper usato per tutti i domain code; nessun `reply.code().send({ code })` diretto in middleware.
- `feedback_aws_sdk_presigner_credentials_chain` (PR #52): setup `AWS_ACCESS_KEY_ID ??=` in Task 7 integration test.
- `feedback_radix_tabs_user_event_not_fire_event` (PR #102 T12): `userEvent.click` (non `fireEvent.click`) per Radix AlertDialog in Task 14.
- `feedback_shadcn_cli_literal_alias_path` (PR #102 T6): heads-up per Dialog install in Task 13.
- `feedback_skip_local_integration_tests`: integration test mandati alla CI, non lanciati localmente.
- `feedback_rls_split_lookup_auth_table` (PR #27): `findFirstOrThrow({ cognitoSub, tenantId })` in tutti i 3 handler avatar.
- `feedback_handler_change_breaks_unit_mock` (PR #98): NON cambio USER_ME_SELECT, solo wrappo con serializer — niente FakePrisma drift.
- `feedback_pr_size_tracking`: Task 16 Step 2 verifica `git diff --stat`.
