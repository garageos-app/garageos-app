# F-OFF-305 — `POST /v1/attachments/upload-url` + `POST /v1/attachments/:id/confirm`

**Data:** 2026-05-04
**Stato:** spec
**Spec parent:** `docs/APPENDICE_A_API.md` §2.7, §3.9
**PR sequence:** PR 23 saga (#49+#50+#51 storage+WAF) → **questo PR (F-OFF-305 attachments upload+confirm)** → eventuale PR dispute attachments wiring → PR 24 (SES+Scheduler+Monitoring per compression/thumbnail)

---

## 1. Obiettivo

Implementare il workflow di upload allegati intervention end-to-end via presigned URL S3 lato officina:

1. **`POST /v1/attachments/upload-url`** — Lambda firma URL S3 PUT presigned (15 min), insert `attachments` row con `processed: false`, ritorna URL + metadata + callback URL al client.
2. **`POST /v1/attachments/:id/confirm`** — Lambda verifica via `HeadObject` che il file sia stato caricato su S3 con `Content-Length` e `Content-Type` consistenti, flippa `processed: false → true`. Idempotent.

PR 23 (#49+#50+#51) ha shipped la infra: bucket S3 `garageos-production-attachments` LIVE, IAM grant `s3:GetObject + s3:PutObject` LIVE, env var `S3_ATTACHMENTS_BUCKET` LIVE. Questa PR consuma quegli artefatti per chiudere il loop attachments officina-side.

**Non in scope (deferred):**

- `intervention_dispute` ownerType extension (PR successivo che chiude debt da PR #21 dispute attachments-not-supported guard).
- `private_intervention` ownerType + customer-side endpoint (PR D opzione roadmap).
- Compression/thumbnail post-process (`thumbnailS3Key` resta sempre `null` in v1; cluster G PR 24 con EventBridge fan-out lo aggiungerà).
- DELETE endpoint sugli allegati (ownership/permission rules da definire separatamente — high abuse vector).
- Soft delete via `deletedAt` (campo esiste in schema ma no API per settarlo).
- Access log automation per attachment lifecycle (decisione: skip per v1; il parent intervention ha già access log via `vehicleOwnership` flow).
- BR-XXX explicit per attachment lifecycle (APPENDICE_F non ha BR codici dedicati a attachment in v1; le rule applicabili sono BR-068 ownership intervention).

## 2. Contesto e prerequisiti

**Stato di partenza (post merge PR #51 al 2026-05-04):**

- `main` HEAD `124acf5`. Working tree pulito salvo `docs/superpowers/{plans,specs}/` untracked (pattern stabilito).
- `infrastructure/`: 6 construct LIVE (DNS, Secrets, Cognito, Storage, LambdaApi, ApiGateway). `WafConstruct` esiste come reusable scaffolding ma NOT instantiated. `attachmentsBucket` esposto via prop a LambdaApi che ha `s3:GetObject + s3:PutObject` IAM grant scoped a `bucketArn/*`.
- `Attachment` Prisma model (`packages/database/prisma/schema.prisma:570`) ha già tutti i campi necessari: `ownerType`, `ownerId`, `tenantId`, `customerId`, `uploadedByUserId`, `uploadedByCustomerId`, `fileName`, `mimeType`, `sizeBytes`, `s3Key`, `s3Bucket`, `processed`, `thumbnailS3Key`, `createdAt`, `deletedAt`. Index su `(ownerType, ownerId)` e `(tenantId)`. RLS già configured (mirror del pattern interventions split SELECT/WRITE).
- `AttachmentOwnerType` enum ha solo `intervention | private_intervention` (manca `intervention_dispute`).
- `packages/api/src/lib/cognito.ts` mostra il pattern AWS SDK singleton + lazy init + test reset hook + typed errors → mirror per `lib/s3.ts`.
- API codebase: ZERO usi di `@aws-sdk/client-s3` o `@aws-sdk/s3-request-presigner`. Nuovi dep da aggiungere.
- Lambda runtime env già contiene `S3_ATTACHMENTS_BUCKET` (PR #49 wired). `env.ts` nel api package va esteso per parsing della var.

**Vincoli:**

- Hard limit 1500 righe diff PR (alert 1200). Stima ~920 righe ben dentro.
- Endpoint solo officina pool in v1 (clienti pool blocked finché PR D).
- Solo `owner_type: intervention` accettato in v1 (private_intervention rejected con 422).
- Whitelist mime: `image/jpeg`, `image/png`, `image/webp`, `image/heic`, `application/pdf`. Reject altro 422.
- Size max 25 MB (26 214 400 bytes).
- Presigned URL expiry 15 minuti.
- `s3Key` generato server-side (mai accept user-provided file_name nel key per path traversal protection).
- AWS SDK call (presign + HeadObject) richiede `region` esplicito da env. `env.AWS_REGION` già parsed in `config/env.ts`.

## 3. Architettura

### 3.1 Layout file modificati / creati

```
packages/api/
├── src/
│   ├── routes/v1/
│   │   └── attachments.ts          # NEW — 2 route handler (upload-url + confirm) + Zod + helper (~250 righe)
│   ├── lib/
│   │   └── s3.ts                   # NEW — S3Client singleton + presign helpers + typed errors (~80 righe)
│   ├── config/
│   │   └── env.ts                  # MODIFIED — +S3_ATTACHMENTS_BUCKET parsing (+5 righe)
│   └── server.ts                   # MODIFIED — +1 register (~+2 righe)
├── tests/
│   ├── unit/routes/
│   │   └── attachments.test.ts     # NEW — handler unit con S3Client stub (~280 righe)
│   └── integration/routes/
│       └── attachments.test.ts     # NEW — integration con Postgres real + S3 stub (~250 righe)
└── package.json                    # MODIFIED — +2 deps runtime + 0 devDeps (~+3 righe)

docs/
├── APPENDICE_A_API.md              # MODIFIED — §2.7 expand (+15 righe), §3.9 row aggiornato (+5 righe)
└── APPENDICE_G_ERROR_CODES.md      # MODIFIED — nuovo §3.16 con 11 error codes (+30 righe)
```

Niente schema migration DB (tutti i campi esistono già). Niente nuovi pacchetti workspace.

### 3.2 `lib/s3.ts` shape

Mirror del pattern `lib/cognito.ts`:

```typescript
import {
  HeadObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { env } from '../config/env.js';

// Lazy singleton. SDK client mantiene HTTP/2 connection pool — un'istanza
// per Lambda warm container. Test usano `_resetS3ClientForTests` per
// permettere ad aws-sdk-client-mock di overridare il transport prima
// di ogni test setup.
let _client: S3Client | null = null;

export function getS3Client(): S3Client {
  if (_client) return _client;
  _client = new S3Client({ region: env.AWS_REGION });
  return _client;
}

export function _resetS3ClientForTests(): void {
  _client = null;
}

// Helpers wrappano le SDK call con typed errors per error-handler mapping.
export interface PresignedPutInput {
  bucket: string;
  key: string;
  contentType: string;
  contentLength: number;
  expiresInSeconds: number;
}

export async function presignPutObject(input: PresignedPutInput): Promise<string> {
  try {
    const command = new PutObjectCommand({
      Bucket: input.bucket,
      Key: input.key,
      ContentType: input.contentType,
      ContentLength: input.contentLength,
    });
    return await getSignedUrl(getS3Client(), command, { expiresIn: input.expiresInSeconds });
  } catch (cause) {
    throw new S3UnavailableError('Failed to sign presigned PUT URL', cause);
  }
}

export interface HeadObjectResult {
  contentLength: number;
  contentType: string;
}

export async function headObject(bucket: string, key: string): Promise<HeadObjectResult> {
  try {
    const response = await getS3Client().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    if (response.ContentLength == null || response.ContentType == null) {
      throw new S3UnavailableError('HeadObject response missing required metadata');
    }
    return { contentLength: response.ContentLength, contentType: response.ContentType };
  } catch (err) {
    if (err instanceof NoSuchKey || isHttpStatus(err, 404)) {
      throw new S3ObjectNotFoundError(`Object not found: ${key}`);
    }
    if (err instanceof S3UnavailableError) throw err;
    throw new S3UnavailableError('HeadObject failed', err);
  }
}

function isHttpStatus(err: unknown, status: number): boolean {
  return err instanceof S3ServiceException && err.$metadata.httpStatusCode === status;
}

// Typed errors. Route handler catch by `name` e mappa a HTTP code.
export class S3ObjectNotFoundError extends Error {
  override name = 'S3ObjectNotFoundError';
}

export class S3UnavailableError extends Error {
  override name = 'S3UnavailableError';
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
  }
}
```

**Note di implementazione:**

- `S3Client` lazy + singleton pattern identico a `cognito.ts`. Per warm Lambda container resta in memoria — riusa connection pool HTTP/2 tra invocation.
- `presignPutObject` wraps `@aws-sdk/s3-request-presigner.getSignedUrl`. ContentType + ContentLength condition signed nell'URL — S3 reject se client PUT con header diversi.
- `headObject` distingue `NoSuchKey` (object missing → 422 client-actionable) da generic AWS error (5xx → 502).
- Typed errors mirror `cognito.ts` con `override name` per error-handler dot-separated mapping.

### 3.3 `routes/v1/attachments.ts` shape

```typescript
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';

import {
  AttachmentOwnerType,
  type PrismaClient,
} from '@garageos/database';

import { businessError } from '../../lib/business-error.js';
import {
  S3ObjectNotFoundError,
  S3UnavailableError,
  headObject,
  presignPutObject,
} from '../../lib/s3.js';
import { env } from '../../config/env.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';

const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/pdf',
] as const;

const MAX_SIZE_BYTES = 26_214_400; // 25 MB
const PRESIGNED_URL_EXPIRY_SECONDS = 900; // 15 min

const UploadUrlSchema = z.object({
  owner_type: z.enum(['intervention', 'private_intervention']),
  owner_id: z.string().uuid(),
  file_name: z
    .string()
    .min(1)
    .max(255)
    .refine((v) => !/[\x00-\x1F]/.test(v), 'control bytes not allowed'),
  mime_type: z.enum(ALLOWED_MIME_TYPES),
  size_bytes: z.number().int().positive().max(MAX_SIZE_BYTES),
});

const ConfirmParamsSchema = z.object({
  id: z.string().uuid(),
});

function deriveExtension(mimeType: string): string {
  switch (mimeType) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/heic':
      return 'heic';
    case 'application/pdf':
      return 'pdf';
    default:
      throw new Error(`Unreachable: unsupported mime ${mimeType}`);
  }
}

const attachmentsRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/v1/attachments/upload-url',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext],
    },
    async (request, reply) => {
      const body = UploadUrlSchema.parse(request.body);

      if (body.owner_type === 'private_intervention') {
        throw businessError(
          'attachment.upload.private_intervention_not_supported',
          422,
          'Customer-side private interventions non ancora supportato in v1.',
        );
      }

      const tenantId = request.tenantId!;
      const cognitoSub = request.userId!;

      return app.withContext({ tenantId }, async (tx) => {
        const user = await tx.user.findFirstOrThrow({
          where: { cognitoSub, tenantId },
          select: { id: true },
        });

        try {
          await tx.intervention.findFirstOrThrow({
            where: { id: body.owner_id, tenantId },
            select: { id: true },
          });
        } catch {
          throw businessError(
            'attachment.upload.intervention_not_found',
            404,
            `Intervention ${body.owner_id} non trovato o non appartiene al tuo tenant.`,
          );
        }

        const attachmentId = randomUUID();
        const ext = deriveExtension(body.mime_type);
        const s3Key = `attachments/${body.owner_type}/${body.owner_id}/${attachmentId}.${ext}`;
        const bucket = env.S3_ATTACHMENTS_BUCKET;

        await tx.attachment.create({
          data: {
            id: attachmentId,
            ownerType: body.owner_type as AttachmentOwnerType,
            ownerId: body.owner_id,
            tenantId,
            uploadedByUserId: user.id,
            fileName: body.file_name,
            mimeType: body.mime_type,
            sizeBytes: body.size_bytes,
            s3Key,
            s3Bucket: bucket,
            processed: false,
          },
        });

        let uploadUrl: string;
        try {
          uploadUrl = await presignPutObject({
            bucket,
            key: s3Key,
            contentType: body.mime_type,
            contentLength: body.size_bytes,
            expiresInSeconds: PRESIGNED_URL_EXPIRY_SECONDS,
          });
        } catch (err) {
          if (err instanceof S3UnavailableError) {
            throw businessError(
              'attachment.upload.s3_unavailable',
              502,
              'Servizio storage temporaneamente non disponibile.',
            );
          }
          throw err;
        }

        const expiresAt = new Date(Date.now() + PRESIGNED_URL_EXPIRY_SECONDS * 1000).toISOString();

        return reply.code(201).send({
          attachment_id: attachmentId,
          upload_url: uploadUrl,
          upload_method: 'PUT',
          upload_headers: { 'Content-Type': body.mime_type },
          expires_at: expiresAt,
          callback_url: `/v1/attachments/${attachmentId}/confirm`,
        });
      });
    },
  );

  app.post(
    '/v1/attachments/:id/confirm',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext],
    },
    async (request, reply) => {
      const { id } = ConfirmParamsSchema.parse(request.params);
      const tenantId = request.tenantId!;
      const cognitoSub = request.userId!;

      return app.withContext({ tenantId }, async (tx) => {
        const user = await tx.user.findFirstOrThrow({
          where: { cognitoSub, tenantId },
          select: { id: true },
        });

        const attachment = await tx.attachment
          .findFirstOrThrow({
            where: { id, tenantId },
          })
          .catch(() => {
            throw businessError(
              'attachment.confirm.not_found',
              404,
              `Attachment ${id} non trovato.`,
            );
          });

        if (attachment.uploadedByUserId !== user.id) {
          throw businessError(
            'attachment.confirm.not_uploader',
            403,
            'Solo chi ha richiesto upload-url può confirmare.',
          );
        }

        if (attachment.processed) {
          // Idempotent — return current state without S3 verification.
          return reply.code(200).send(serializeAttachment(attachment));
        }

        let head: { contentLength: number; contentType: string };
        try {
          head = await headObject(attachment.s3Bucket, attachment.s3Key);
        } catch (err) {
          if (err instanceof S3ObjectNotFoundError) {
            throw businessError(
              'attachment.confirm.upload_not_found',
              422,
              'File non trovato su S3 — l\'upload non è atterrato o è expirato.',
            );
          }
          if (err instanceof S3UnavailableError) {
            throw businessError(
              'attachment.confirm.s3_unavailable',
              502,
              'Servizio storage temporaneamente non disponibile.',
            );
          }
          throw err;
        }

        if (head.contentLength !== attachment.sizeBytes || head.contentType !== attachment.mimeType) {
          throw businessError(
            'attachment.confirm.metadata_mismatch',
            422,
            `S3 metadata non matcha la richiesta originale: size ${head.contentLength}/${attachment.sizeBytes}, type ${head.contentType}/${attachment.mimeType}.`,
          );
        }

        const updated = await tx.attachment.update({
          where: { id },
          data: { processed: true },
        });

        return reply.code(200).send(serializeAttachment(updated));
      });
    },
  );
};

function serializeAttachment(attachment: {
  id: string;
  ownerType: AttachmentOwnerType;
  ownerId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  processed: boolean;
  createdAt: Date;
}) {
  return {
    id: attachment.id,
    owner_type: attachment.ownerType,
    owner_id: attachment.ownerId,
    file_name: attachment.fileName,
    mime_type: attachment.mimeType,
    size_bytes: attachment.sizeBytes,
    processed: attachment.processed,
    uploaded_at: attachment.createdAt.toISOString(),
  };
}

export default attachmentsRoutes;
```

**Note di implementazione:**

- `requireOfficinaPool` middleware esiste già (PR #19 me-vehicles). Usa il claim `cognito:groups` o equivalente per separare officina da clienti pool. Customer call → 403 prima di arrivare al handler.
- `tenantContext` middleware popola `request.tenantId` da `custom:tenant_id` claim.
- `withContext({ tenantId })` settа `current_tenant_id()` SQL session per RLS scoping.
- `findFirstOrThrow` su `users` con `(cognitoSub, tenantId)` pattern post-PR #27 (defense-in-depth contro JWT cross-tenant).
- `findFirstOrThrow` su `interventions` ritorna P2025 se RLS filtra fuori (cross-tenant) o se id non esiste — entrambi mappano a 404 client-side (BR-150 RLS-as-404 pattern post split #22).
- Idempotent confirm: se `processed === true`, return 200 senza re-call S3 (no rate consumption + nessuna race se 2 client confirmano insieme).
- Wire format JSON: snake_case in payload (matcha APPENDICE_A literal), Prisma fields restano camelCase (Prisma mapping standard).
- Date serialization via `.toISOString()` per ISO 8601 UTC (APPENDICE_A §4.3).

### 3.4 `config/env.ts` modifications

```typescript
// Aggiungere alla schema Zod / object literal:
S3_ATTACHMENTS_BUCKET: z.string().min(1),
```

Default in test setup: `'garageos-test-attachments'` literal — il test stub di S3Client non valida bucket name reale, è solo per logging/comparison.

### 3.5 `server.ts` register

```typescript
// Dopo gli altri register di routes/v1/:
await app.register(import('./routes/v1/attachments.js'));
```

### 3.6 `package.json` deps

```jsonc
"dependencies": {
  // ... existing ...
  "@aws-sdk/client-s3": "^3.x",
  "@aws-sdk/s3-request-presigner": "^3.x"
}
```

`aws-sdk-client-mock` è già devDep (post PR #48 cognito tests), quindi non aggiungere.

## 4. Decisioni esplicite

| ID | Decisione | Rationale |
|---|---|---|
| Q1 | Both endpoints (upload-url + confirm) in 1 PR | Workflow chiuso, no dangling state |
| Q2 | Solo `intervention` ownerType in v1 | YAGNI; private_intervention bloccato finché PR D ship |
| Q3 | Mime whitelist (5 tipi) + 25 MB cap + server-side `s3Key` derivation | Security defaults; path traversal prevention |
| Q4 | Idempotent confirm + uploader-only auth + HeadObject metadata check (size + content-type) | Defense-in-depth; safe retry |
| D1 | `lib/s3.ts` singleton mirror `lib/cognito.ts` | Pattern consistency |
| D2 | No compression/thumbnail in v1 (`thumbnailS3Key` resta `null`) | Deferred a cluster G PR 24 (EventBridge) |
| D3 | No access_log per attachment lifecycle | Skip — può essere aggiunto se BR lo richiede; parent intervention ha già access log via vehicleOwnership flow |
| D4 | Presigned URL expiry 15 min | AWS default sicuro; bilancia user friction vs URL abuse window |
| D5 | ContentType + ContentLength condition signed nell'URL | Defense vs upload manipulation post-presign |
| D6 | Auth officina-only (clienti rejected dal middleware require-officina-pool) | Mirror del pattern create intervention; customer-side workflow è PR D |

## 5. Test plan

### 5.1 Unit test `tests/unit/routes/attachments.test.ts` (~12 test)

**Setup**: Vitest + `vi.mock` su Prisma client + `aws-sdk-client-mock` su S3Client. `_resetS3ClientForTests()` in `beforeEach`.

**POST upload-url (happy + edge)**:

1. `happy path: returns 201 con tutti i campi response`
2. `rejects mime_type fuori whitelist con 422 attachment.upload.mime_type_not_allowed`
3. `rejects size_bytes > 25MB con 422 attachment.upload.size_too_large`
4. `rejects file_name vuoto/null bytes con 422 attachment.upload.invalid_file_name`
5. `rejects intervention non trovato (P2025) con 404 attachment.upload.intervention_not_found`
6. `rejects owner_type private_intervention con 422 attachment.upload.private_intervention_not_supported`
7. `s3 sdk failure → 502 attachment.upload.s3_unavailable`
8. `s3Key derivation: image/jpeg → .jpg, application/pdf → .pdf, ecc.`

**POST confirm (happy + edge)**:

9. `happy path: HeadObject ok → flippa processed: true, return 200`
10. `idempotent: già processed → return 200 senza re-call S3`
11. `attachment non trovato (P2025) → 404 attachment.confirm.not_found`
12. `uploader mismatch → 403 attachment.confirm.not_uploader`
13. `S3 NoSuchKey → 422 attachment.confirm.upload_not_found`
14. `ContentLength mismatch → 422 attachment.confirm.metadata_mismatch`
15. `ContentType mismatch → 422 attachment.confirm.metadata_mismatch`
16. `S3 generic error → 502 attachment.confirm.s3_unavailable`

(Totale: 16 unit test sui due route handler.)

### 5.2 Integration test `tests/integration/routes/attachments.test.ts` (~8 test)

**Setup**: Postgres real via testcontainer + Prisma. S3Client stubbed via `aws-sdk-client-mock`. Auth helper crea JWT signed con tenant officina test.

1. `POST upload-url + confirm full happy flow (officina A)`
2. `cross-tenant isolation: officina A non vede attachment officina B (RLS-as-404)`
3. `idempotent confirm: chiamato 2 volte ritorna 200 stesso payload`
4. `auth gate: clienti pool JWT → 403 (require-officina-pool reject)`
5. `unauth: no JWT → 401`
6. `RLS check: cross-tenant intervention reference → 404 (RLS scoping)`
7. `attachment.uploadedByUserId persisted correctly da claim user.id`
8. `Prisma SELECT → applicato RLS, attachment row visibile solo a tenant A`

**Setup helper riusato**:

- Pattern `createOfficinaTestApp` con factory + JWT signing (post PR #48 setup)
- `aws-sdk-client-mock` reset in `beforeEach`

### 5.3 CI gate

- `pnpm --filter @garageos/api test:unit` — passa da ~316 a ~332 (16 nuovi)
- `pnpm --filter @garageos/api test:integration` — passa da ~150 a ~158 (8 nuovi)
- `pnpm -r typecheck` — pre-push hook
- `pnpm --filter @garageos/api build` — verifica esbuild bundling con nuovi AWS SDK deps

### 5.4 Smoke post-deploy (operator-driven)

Manual smoke (no auto-trigger):

```bash
# 1. Get bearer token
TOKEN=$(aws cognito-idp admin-initiate-auth ... --query "AuthenticationResult.IdToken" --output text)

# 2. Request upload-url
RESPONSE=$(curl -s -X POST https://api.garageos.aifollyadvisor.com/v1/attachments/upload-url \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"owner_type":"intervention","owner_id":"<existing-intervention-uuid>","file_name":"test.jpg","mime_type":"image/jpeg","size_bytes":1024}')
echo "$RESPONSE" | jq

# 3. PUT a file con curl
ATTACHMENT_ID=$(echo "$RESPONSE" | jq -r '.attachment_id')
UPLOAD_URL=$(echo "$RESPONSE" | jq -r '.upload_url')
echo "test content" > /tmp/test.jpg
curl -X PUT -H "Content-Type: image/jpeg" --data-binary @/tmp/test.jpg "$UPLOAD_URL"

# 4. Confirm
curl -s -X POST "https://api.garageos.aifollyadvisor.com/v1/attachments/${ATTACHMENT_ID}/confirm" \
  -H "Authorization: Bearer $TOKEN" | jq

# Expected: response con processed: true
```

(Nota: il smoke richiede un'`intervention` già esistente nel tenant — usa quella creata dal F7.5 admin bootstrap o crea via POST /v1/vehicles/:id/interventions.)

## 6. Doc updates

### 6.1 `APPENDICE_A_API.md`

**§2.7** — espandere con detail completo dei 2 endpoint (request/response/errori) sostituendo la stub attuale.

**§3.9 Attachments** — aggiornare row table:

| Metodo | Path | Feature | Auth | Descrizione |
|---|---|---|---|---|
| POST | `/attachments/upload-url` | F-OFF-305 | Tenant User | **[DETTAGLIATO §2.7]** Richiede presigned URL upload |
| POST | `/attachments/:id/confirm` | F-OFF-305 | Tenant User | **[DETTAGLIATO §2.7]** Conferma upload completato |
| GET | `/attachments/:id` | F-OFF-305 | Any User | (deferred) Dettaglio attachment metadata |

### 6.2 `APPENDICE_G_ERROR_CODES.md`

**Nuovo §3.16 Attachments** con 11 error codes (tabella + mappatura HTTP + descrizione + suggerimento client).

## 7. Tech debt

### 7.1 Aperto in questo PR

| Voce | Priority | Quando chiuderlo |
|---|---|---|
| `intervention_dispute` ownerType extension + dispute attachments wiring | low | Quando il dispute attachments workflow F-CLI-206 è priority (probabile post-cluster G notification) — chiude debt PR #21 attachments-not-supported guard |
| `private_intervention` ownerType + customer-side endpoint | medium | PR D opzione roadmap (private interventions CRUD) |
| Compression/thumbnail post-process | low | Cluster G PR 24 (EventBridge) — flip `processed: true` triggera enqueue |
| GET `/attachments/:id` endpoint (metadata read) | low | Quando viewer UI lo richiede |
| DELETE `/attachments/:id` endpoint | low | Solo se ownership/permission rules ben definite (high abuse vector senza) |
| Soft delete via `deletedAt` | low | Insieme a DELETE endpoint |
| Pre-emptive S3 IAM grant cleanup | very-low | Review post questo PR ship: confermare action list o ridimensione (debt aperto da PR #51 doc) |

### 7.2 Validation gate per debt esistenti

| Voce | PR origine | Note |
|---|---|---|
| `Pre-emptive S3 IAM grant verification` | PR #51 | Questo PR è il primo caller reale di `s3:PutObject` (presign PUT URL) + `s3:GetObject` (HeadObject lo richiede via S3 SDK contract — anche se HeadObject di per sé non legge contenuto, il signed URL signing path richiede GetObject permission per poll). Validation: deploy + smoke confirma entrambe le action sono effettivamente usate; il debt voce su `project_tech_debt.md` (review post-F-OFF-305) chiude come "verified — minimal grant adequate". |

## 8. Stima dimensioni PR

| File | Tipo | Righe stimate |
|---|---|---|
| `packages/api/src/lib/s3.ts` | NEW | ~80 |
| `packages/api/src/routes/v1/attachments.ts` | NEW | ~250 |
| `packages/api/src/config/env.ts` | MODIFIED | +5 |
| `packages/api/src/server.ts` | MODIFIED | +2 |
| `packages/api/tests/unit/routes/attachments.test.ts` | NEW | ~280 |
| `packages/api/tests/integration/routes/attachments.test.ts` | NEW | ~250 |
| `packages/api/package.json` | MODIFIED | +3 |
| `docs/APPENDICE_A_API.md` | MODIFIED | +20 |
| `docs/APPENDICE_G_ERROR_CODES.md` | MODIFIED | +30 |
| **Totale stimato** | | **~920 righe net** |

Sotto soglia 1200 (alert) e 1500 (hard). Probabili ±100 righe in implementation.

## 9. Rischi e mitigazioni

| Rischio | Probabilità | Impatto | Mitigazione |
|---|---|---|---|
| AWS SDK presigner incompatibile con Lambda runtime ESM bundling | bassa | medio | `cognito.ts` (post PR #48) ha già lo stesso pattern + esbuild bundling — proven in CI/prod |
| `getSignedUrl` lentezza in cold start (~500ms?) | bassa | basso | SDK è in-process, no HTTP roundtrip — typical signing <100ms |
| Lambda env var `S3_ATTACHMENTS_BUCKET` missing al cold start | bassa | alto (502) | Test `env.ts` loader + integration test verifica via `app.envParsed` |
| `aws-sdk-client-mock` API change tra major versions | bassa | basso | Lock to current major in `package.json`; aggiornamenti semver-controlled |
| ContentType conditioning blocca upload legittimi se client manda `image/jpeg; charset=` (con parameter) | media | basso (422 client-actionable) | Test esplicito + doc nota: client deve PUT con esatto `Content-Type: image/jpeg` (no params) |
| RLS scoping permissivo post split #22 → cross-tenant intervention reference returns 404 invece di 403 | nulla (intended) | none | Documentato in `feedback_rls_split_changes_endpoint_semantics.md` |
| ContentLength mismatch perché client invia file diverso da quello dichiarato | media | basso (422 client-actionable) | Confirm step cattura tramite HeadObject; client deve allineare size_bytes a file size reale |

## 10. Ordine commit consigliato

Atomic commit stile PR #48:

1. `feat(api): add S3 client lib with typed errors` — solo `lib/s3.ts` + `config/env.ts` extension + 2 deps.
2. `feat(api): add POST /v1/attachments/upload-url` — solo upload-url handler + Zod + helper + unit test corrispondenti.
3. `feat(api): add POST /v1/attachments/:id/confirm` — confirm handler + unit test.
4. `test(api): integration test for attachments upload+confirm flow` — integration suite.
5. `feat(api): register attachments routes in server` — `server.ts` register.
6. `docs(api): expand APPENDICE_A §2.7 and §3.9 attachments` — doc API.
7. `docs(api): add APPENDICE_G §3.16 attachments error codes` — doc error.

Squash come unico commit alla merge.

## 11. Sequenza post-PR

PR successiva candidata (post merge questo PR):

- **Dispute attachments wiring** — chiude debt PR #21. Add `intervention_dispute` enum value + RLS migration + remove guard 422 in `interventions-dispute.ts` + populate `attachment_ids` (FK schema?) + tests. Stima ~400-600 righe.
- **GAP-fill `/v1/vehicles/search?customer=` filter** — sub-feature di Opzione E. Stima ~100-200 righe.
- **PR D — `/me/private-interventions` CRUD customer-side** — sblocca `private_intervention` ownerType in attachments. Stima ~800-1000 righe.
- **PR 24 — SES + Scheduler + Monitoring (cluster G)** — sblocca compression/thumbnail post-process per attachments + verify-email + BR-064/066/129 notification. Stima ~700-1000 righe.

Decisione rinviata a fine merge.
