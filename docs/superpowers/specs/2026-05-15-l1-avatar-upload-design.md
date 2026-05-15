# Slice L1 — Avatar upload (F-OFF-007 follow-up)

**Status:** draft
**Date:** 2026-05-15
**Feature ID:** F-OFF-007 (continuation post-PR #102)
**Slice tag:** L1
**Stima LOC:** ~1100

## Contesto

Il settings page F-OFF-007 (PR #102 / slice L) ha shippato profile self-edit (nome, cognome, telefono) e tenant edit (super_admin). Resta da implementare la modifica della **foto profilo** dell'utente, citata in `docs/GarageOS-Specifiche.md` §F-OFF-007 ("ogni utente può modificare i propri dati (nome, foto, password)") e prevista in `docs/APPENDICE_A_API.md` §3.3 come `POST /users/me/avatar`.

Lo schema DB ha già il campo `users.avatar_url VARCHAR(500) NULL` (`packages/database/prisma/schema.prisma:267`). Manca il backend per upload/delete, la UI di crop + remove, e l'integrazione visiva nell'AppLayout TopBar (che oggi mostra solo l'email).

Out of scope per L1:
- Avatar in InterventionRow / DisputeResponse / qualsiasi altro punto dove appare un User
- Tenant logo upload (`tenants.logo_url` esistente ma differita a slice futuro)
- Server-side image processing (sharp/Lambda layer)
- Cambio password (slice L2 separata, già pianificata)

## Decisioni architetturali

### Storage & access — Privato + presigned GET

Riuso del bucket `S3_ATTACHMENTS_BUCKET` con prefix `avatars/users/`. Niente nuova infra CDK (no public bucket, no CloudFront origin extra).

- **DB stora la S3 key**, non la URL: `avatar_url = 'avatars/users/<user-id>.jpg'`.
- L'API serializer `GET /v1/users/me` trasforma la key in **presigned GET URL** 15-min al momento della response.
- React Query `users-me` ha `staleTime = 5 min` → al refresh viene rigenerata una URL fresca prima della scadenza.

Pattern coerente con `view-url` di F-OFF-301 attachments (lesson `feedback_rls_split_changes_endpoint_semantics` non si applica: avatar non è cross-tenant).

### API shape — 2-phase dedicated, no `attachments` row

Avatar è single-value per user (1:1), non polimorfico. Non riusiamo la tabella `attachments` (sarebbe overkill: enum extension + righe storiche). Tre endpoint dedicati:

| Method | Path | Scopo |
|---|---|---|
| POST | `/v1/users/me/avatar/upload-url` | Issue presigned PUT URL |
| POST | `/v1/users/me/avatar/confirm` | HeadObject verify + UPDATE `users.avatar_url` |
| DELETE | `/v1/users/me/avatar` | DeleteObject + UPDATE `users.avatar_url = NULL` |

`GET /v1/users/me` (esistente) viene **augmentato** per serializzare `avatar_url` come URL invece di key.

### Crop UX — react-easy-crop, 1:1, output JPEG 512×512

Modal con `react-easy-crop` (MIT, ~10 KB gzipped, mantenuto, ~2.5M downloads/week npm).
- `aspect={1}`, `cropShape="round"` (preview circolare, output è comunque quadrato)
- Zoom + pan
- Su confirm: canvas 2D crop+resize a 512×512, `toBlob('image/jpeg', 0.85)` → ~50-150 KB output

Constraint input: JPEG/PNG/WebP, max 5 MB. Output sempre JPEG (mime fissato server-side).

### Scope UI

- **ProfileForm**: nuova sezione `AvatarSection` (preview + "Cambia foto" + "Rimuovi")
- **TopBar**: il `DropdownMenuTrigger` esistente (oggi `<span>{email}</span>`) viene esteso con avatar 32px tondo + fallback iniziali. Niente Sidebar changes (Sidebar non mostra l'utente).
- **Nessun altro componente** modificato in L1.

### Delete behavior — Sì, idempotent

`DELETE /v1/users/me/avatar`:
- Se `avatar_url IS NOT NULL`: DeleteObject S3 + UPDATE `users SET avatar_url = NULL`
- Se già NULL: no-op silent (idempotent, ritorna 204 comunque)
- DeleteObject best-effort: se S3 fallisce ma DB ha avuto successo, la key orfana è acceptable (cleanup job futuro o ignored — verrà sovrascritta al prossimo upload visto che la key è deterministica)
- Response: `204 No Content`

## Architettura — flusso end-to-end

```
ProfileForm: click "Cambia foto"
       │
       ▼
File picker → validate (mime ∈ {jpeg,png,webp}, size ≤ 5MB) → AvatarCropDialog
       │
       ▼  (crop 1:1, output JPEG 512×512 ~85% via canvas)
       │
       ▼  Blob
useAvatarUpload hook:
  1. POST /v1/users/me/avatar/upload-url      → { upload_url, upload_method, upload_headers, expires_at }
  2. XHR PUT to S3 (deterministic key)        → progress events
  3. POST /v1/users/me/avatar/confirm          → HeadObject + UPDATE users.avatar_url, returns USER_ME_SELECT
       │
       ▼
queryClient.invalidate(['users-me'])
GET /v1/users/me returns fresh presigned 15-min URL
ProfileForm.AvatarSection + TopBar render new avatar
```

## Componenti — boundary

### Backend

| File | Cosa fa | Dipendenze |
|---|---|---|
| `packages/api/src/routes/v1/users-avatar.ts` (nuovo) | 3 handler (upload-url, confirm, delete) | `lib/s3.ts`, `lib/dtos/user-me.ts` |
| `packages/api/src/lib/avatar-presign.ts` (nuovo) | Helper `keyToPresignedUrl(key, expirySeconds)` | `lib/s3.ts` |
| `packages/api/src/lib/dtos/user-me.ts` (esistente, augment) | Aggiunge `serializeUserMe(row)`: converte `avatarUrl` key → presigned URL o null | — |
| `packages/api/src/routes/v1/users.ts` (esistente, update) | `GET /v1/users/me` usa `serializeUserMe` | — |
| `packages/api/src/routes/v1/users-update.ts` (esistente, update) | `PATCH /v1/users/me` usa `serializeUserMe` per consistency | — |

### Frontend

| File | Cosa fa | Dipendenze |
|---|---|---|
| `packages/web/src/queries/avatarUpload.ts` (nuovo) | Hook state machine 2-phase + XHR | `api-client` |
| `packages/web/src/lib/avatarCanvas.ts` (nuovo) | Pure util: crop+resize → Blob JPEG | — |
| `packages/web/src/components/settings/AvatarCropDialog.tsx` (nuovo) | shadcn Dialog wrapping react-easy-crop | react-easy-crop |
| `packages/web/src/components/settings/AvatarSection.tsx` (nuovo) | UI in ProfileForm: preview + "Cambia foto" + "Rimuovi" + progress | hook + dialog |
| `packages/web/src/components/settings/ProfileForm.tsx` (esistente, update) | Mount `<AvatarSection />` sopra i campi anagrafici | — |
| `packages/web/src/components/layout/TopBar.tsx` (esistente, update) | Avatar 32px nel DropdownMenuTrigger, fallback iniziali | `useProfileMe` |
| `packages/web/src/queries/profileMe.ts` (esistente, update) | Tipo `ProfileMeDto.avatarUrl: string \| null` — già presente, valore semantica cambia (era key, ora URL completa) | — |
| `packages/web/src/lib/initials.ts` (nuovo o inline) | `getInitials(firstName, lastName)` per fallback | — |

## Endpoint specs

### `POST /v1/users/me/avatar/upload-url`

**Auth**: `requireAuth + requireOfficinaPool + tenantContext`

**Body**: `{}` (vuoto)

**Response 200**:
```json
{
  "upload_url": "https://...s3...",
  "upload_method": "PUT",
  "upload_headers": { "Content-Type": "image/jpeg" },
  "expires_at": "2026-05-15T12:30:00Z"
}
```

**Errors**:
- `users.me.avatar.s3_unavailable` (502) — `S3UnavailableError` da `presignPutObject`

**Implementazione**:
- `tx.user.findFirstOrThrow({ cognitoSub, tenantId }, { select: { id: true } })` (defense-in-depth post-#27)
- Key deterministica: `avatars/users/${user.id}.jpg`
- `presignPutObject({ bucket: S3_ATTACHMENTS_BUCKET, key, contentType: 'image/jpeg', contentLength: undefined?, expiresInSeconds: 900 })`

> Aside su `contentLength`: il presigner attuale (`lib/s3.ts:42`) richiede `contentLength` nei parametri come defense-in-depth (S3 rifiuta se il client manda byte ≠). Per attachment lo sappiamo a priori (è nel body). Per avatar il Blob è generato client-side e la size esatta non è nota al backend. **Decisione**: omettere `contentLength` dal presign per avatar (refactor leggero a `lib/s3.ts` per renderlo optional) — la deterministic key per user + auth-gated endpoint sono già sufficienti per prevenire abuse, e gli attacker non guadagnerebbero nulla a riempire la `avatars/users/<their-id>.jpg` con file 50 MB perché la chiave è la loro stessa. Eventualmente in futuro: enforcement HeadObject `contentLength <= 1_000_000` in confirm.

### `POST /v1/users/me/avatar/confirm`

**Auth**: `requireAuth + requireOfficinaPool + tenantContext`

**Body**: `{}`

**Response 200**: USER_ME_SELECT con `avatarUrl: string` (presigned URL 15-min)

**Errors**:
- `users.me.avatar.upload_not_found` (422) — `S3ObjectNotFoundError` da HeadObject
- `users.me.avatar.s3_unavailable` (502)
- `users.me.avatar.invalid_mime` (422) — HeadObject `contentType !== 'image/jpeg'` (difesa contro client che PUT-ta un mime diverso)

**Implementazione**:
- `findFirstOrThrow({ cognitoSub, tenantId })`
- `headObject(bucket, 'avatars/users/${user.id}.jpg')`
- Se `contentType !== 'image/jpeg'` → invalid_mime
- `update({ where: { id }, data: { avatarUrl: 'avatars/users/${user.id}.jpg' }, select: USER_ME_SELECT })`
- Return `serializeUserMe(updated)`

**Idempotente**: re-call dopo confirm già fatto → HeadObject succeeds, UPDATE è no-op effettivo (stesso valore), ritorna stessa response. Implementazione: nessun early-return necessario, l'UPDATE è cheap.

### `DELETE /v1/users/me/avatar`

**Auth**: `requireAuth + requireOfficinaPool + tenantContext`

**Body**: assente

**Response 204** (no content)

**Errors**: nessuno specifico (S3 delete best-effort; DB update sempre succeeds)

**Implementazione**:
- `findFirstOrThrow({ cognitoSub, tenantId })`
- `DeleteObjectCommand` su `avatars/users/${user.id}.jpg` — best-effort, catch+log (no business error)
- `update({ where: { id }, data: { avatarUrl: null } })`

**Idempotente**: se `avatarUrl` già NULL → comunque DeleteObject (no-op su S3) + UPDATE (no-op SQL).

### `GET /v1/users/me` (augmented) e `PATCH /v1/users/me` (augmented)

Entrambi i due handler esistenti diventano:
```ts
const row = await tx.user.findFirstOrThrow({ where: { cognitoSub, tenantId }, select: USER_ME_SELECT });
return serializeUserMe(row);
```

Dove `serializeUserMe(row)` è:
```ts
async function serializeUserMe(row: UserMeDto): Promise<UserMeDto & { avatarUrl: string | null }> {
  const avatarUrl = row.avatarUrl ? await keyToPresignedUrl(row.avatarUrl, 900) : null;
  return { ...row, avatarUrl };
}
```

Nota: `USER_ME_SELECT` non cambia (`avatarUrl: true` già presente). Solo la trasformazione finale è nuova.

## Errori — APPENDICE_G_ERROR_CODES

Nuovi codici da aggiungere:

| Code | HTTP | Messaggio | Endpoint |
|---|---|---|---|
| `users.me.avatar.upload_not_found` | 422 | File non trovato su S3 — l'upload non è atterrato o è scaduto. | confirm |
| `users.me.avatar.invalid_mime` | 422 | Il file caricato deve essere JPEG. | confirm |
| `users.me.avatar.s3_unavailable` | 502 | Servizio storage temporaneamente non disponibile. | upload-url / confirm |

Pattern: middleware deve **throw FastifyError** (lesson `feedback_middleware_throw_fastifyerror_not_reply_send` PR #102 T1) via `businessError(code, status, detail)`.

## Frontend dettagli

### `avatarCanvas.ts`

```ts
export interface CropArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export async function cropAndResize(
  imageSrc: string,           // object URL from File
  pixelCrop: CropArea,        // pixel coords from react-easy-crop
  outputSize: number = 512,
  quality: number = 0.85,
): Promise<Blob> {
  const image = await loadImage(imageSrc);
  const canvas = document.createElement('canvas');
  canvas.width = outputSize;
  canvas.height = outputSize;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(
    image,
    pixelCrop.x, pixelCrop.y, pixelCrop.width, pixelCrop.height,
    0, 0, outputSize, outputSize,
  );
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('toBlob failed'))),
      'image/jpeg',
      quality,
    ),
  );
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

### `useAvatarUpload`

State machine (idle → requesting → uploading(progress) → confirming → success | error). Pattern parallelo a `useAttachmentUpload` ma:
- Step 1 body: `{}` (niente owner_type/owner_id/file_name/mime_type/size_bytes)
- Step 3 body: `{}`
- On success: `queryClient.invalidateQueries({ queryKey: ['users-me'] })`

### `AvatarCropDialog`

```tsx
<Dialog open={open} onOpenChange={onOpenChange}>
  <DialogContent>
    <DialogHeader><DialogTitle>Ritaglia foto</DialogTitle></DialogHeader>
    <div className="relative h-80 bg-muted">
      <Cropper
        image={imageSrc}
        crop={crop}
        zoom={zoom}
        aspect={1}
        cropShape="round"
        onCropChange={setCrop}
        onZoomChange={setZoom}
        onCropComplete={(_, pixelCrop) => setCroppedAreaPixels(pixelCrop)}
      />
    </div>
    <input type="range" min={1} max={3} step={0.1} value={zoom} onChange={...} />
    <DialogFooter>
      <Button variant="outline" onClick={onCancel}>Annulla</Button>
      <Button onClick={onConfirm} disabled={loading}>{loading ? 'Salvando...' : 'Conferma'}</Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

### `AvatarSection`

```tsx
<div className="flex items-center gap-4">
  {profile.avatarUrl ? (
    <img src={profile.avatarUrl} alt="Avatar" className="w-24 h-24 rounded-full object-cover" />
  ) : (
    <div className="w-24 h-24 rounded-full bg-muted flex items-center justify-center text-2xl font-semibold">
      {getInitials(profile.firstName, profile.lastName)}
    </div>
  )}
  <div className="space-y-2">
    <input type="file" accept="image/jpeg,image/png,image/webp" hidden ref={inputRef} onChange={handleFileSelect} />
    <Button variant="outline" onClick={() => inputRef.current?.click()}>Cambia foto</Button>
    {profile.avatarUrl && (
      <Button variant="ghost" onClick={() => setRemoveOpen(true)}>Rimuovi</Button>
    )}
    {/* Progress bar e error during upload */}
  </div>
  <AvatarCropDialog open={cropOpen} ... />
  <AlertDialog open={removeOpen} ... />  {/* "Sei sicuro di voler rimuovere la foto?" */}
</div>
```

### `TopBar` augment

```tsx
<DropdownMenuTrigger className="flex items-center gap-2 ...">
  {profile?.avatarUrl ? (
    <img src={profile.avatarUrl} alt="" className="w-8 h-8 rounded-full object-cover" />
  ) : (
    <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-xs font-semibold">
      {getInitials(firstName, lastName)}
    </div>
  )}
  <span>{email}</span>
  <ChevronDown size={14} />
</DropdownMenuTrigger>
```

Nota: TopBar oggi usa `useAuth` (Cognito session). Per avere `avatarUrl` + nome occorre chiamare `useProfileMe()` qui — è già cached da React Query, costo zero.

## Testing strategy

### Backend integration (`packages/api/test/integration/users-me-avatar.test.ts`)

- `POST upload-url` → 200, body shape valido, URL contiene firma S3
- `POST confirm` post-PUT mock S3 (aws-sdk-client-mock HeadObject) → 200, `avatarUrl` URL valida nella response, DB `users.avatar_url` = key
- `POST confirm` senza upload (HeadObject NoSuchKey) → 422 `users.me.avatar.upload_not_found`
- `POST confirm` con HeadObject mime mismatch (e.g. `image/png`) → 422 `users.me.avatar.invalid_mime`
- `POST confirm` re-call dopo successo → 200 stessa response (idempotente)
- `DELETE` con avatar presente → 204, DB `avatar_url IS NULL`
- `DELETE` senza avatar (idempotent) → 204
- `GET /users/me` con avatar → response `avatarUrl` è URL (contiene firma S3 + `avatars/users/`)
- `GET /users/me` senza avatar → `avatarUrl: null`
- Cross-tenant: 2 tenant, tenant A confirm; tenant B GET → vede solo il proprio
- Role-neutral: super_admin e mechanic entrambi possono fare upload/confirm/delete

Lesson applicato `feedback_aws_sdk_presigner_credentials_chain`: setup `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` con `??=` nel test setup.

### Backend unit (`packages/api/test/unit/avatar-presign.test.ts`)

- `keyToPresignedUrl`: chiama `presignGetObject` con bucket env + key, espiry 900s
- `serializeUserMe`: avatarUrl=null → null, avatarUrl=key → URL
- Error mapping: `S3UnavailableError` → `users.me.avatar.s3_unavailable` 502

### Frontend unit (`packages/web/src/...`)

- `avatarCanvas.test.ts`: input image 1024×768 + crop → output 512×512 JPEG (mock canvas o jsdom-canvas)
- `avatarUpload.test.tsx`: state machine success path + error paths
- `AvatarSection.test.tsx`: render avatar img, render iniziali fallback, click "Cambia foto" apre file picker (simulato), click "Rimuovi" apre AlertDialog
- `AvatarCropDialog.test.tsx`: open/close, confirm chiama onConfirm con Blob (mock canvas)
- `TopBar.test.tsx`: render avatar img quando profile.avatarUrl, render iniziali altrimenti
- `initials.test.ts`: input combinations → 2 chars uppercase

Lesson applicato `feedback_radix_tabs_user_event_not_fire_event`: per Dialog/AlertDialog usare `userEvent.click`, non `fireEvent.click`.

### Manual smoke (post-deploy prod)

1. Login super_admin → /settings → Profilo
2. "Cambia foto" → seleziona JPEG 2 MB → crop+zoom → Conferma → avatar appare
3. Reload pagina → avatar persistente
4. TopBar mostra avatar 32px (non più solo email)
5. "Rimuovi" → conferma → torna a iniziali; reload → persistenti
6. Repeat con mechanic-test@demo-giuseppe.test
7. Caso edge: upload PNG → resize+JPEG output OK; upload 6 MB → frontend validation block
8. F12 Network: GET /users/me ritorna `avatar_url` come URL S3 con firma (no key raw)

## Dependencies

- **`react-easy-crop`** (new): `^5.x`, ~10 KB gzipped, MIT, `packages/web/package.json`

Nessuna altra dipendenza nuova. Canvas API è browser-native. Blob già usato in `attachmentUpload.ts`. `aws-sdk-client-s3` + `s3-request-presigner` già presenti in `packages/api`.

## Stima LOC

| Layer | LOC |
|---|---|
| Backend `users-avatar.ts` (3 handler) | ~180 |
| Backend `avatar-presign.ts` + `dtos/user-me.ts` augment + `users.ts`/`users-update.ts` integration | ~80 |
| Frontend `avatarUpload.ts` hook | ~150 |
| Frontend `avatarCanvas.ts` util | ~50 |
| Frontend `AvatarCropDialog.tsx` | ~100 |
| Frontend `AvatarSection.tsx` | ~120 |
| Frontend `ProfileForm.tsx` integration | ~10 |
| Frontend `TopBar.tsx` augment + `initials.ts` | ~50 |
| Backend tests (integration + unit) | ~250 |
| Frontend tests (5 file) | ~250 |
| Docs (APPENDICE_A endpoints + APPENDICE_G codes) | ~80 |
| **Totale** | **~1320 LOC** |

Sopra la stima iniziale `200-300 LOC` della memoria checkpoint (sottovalutata). Realistico per slice completo con crop UI + TopBar + test coverage. PR singolo, sotto il soft limit 1500 LOC.

## Business rules

Nessuna nuova BR. F-OFF-007 elenca "foto" come parte di "Profilo utente", non è una BR codificata.

## Open questions risolte durante brainstorming

- ✅ Storage privato + presigned GET (no nuovo bucket pubblico)
- ✅ Crop UX 1:1 con react-easy-crop, output 512×512 JPEG
- ✅ API 2-phase dedicated (no riuso `attachments` table)
- ✅ UI scope: ProfileForm + TopBar (no InterventionRow, no DisputeResponse author)
- ✅ Input mime: JPEG/PNG/WebP, max 5 MB. Output sempre JPEG.
- ✅ DELETE endpoint sì, 204 No Content, idempotente
- ✅ Mime in upload-url fissato server-side a `image/jpeg` (no body, no validation drift)
- ✅ S3 contentLength omesso dal presign (Blob client-side ha size variabile)

## Implementation order suggestion (per la fase di plan)

1. Backend: helper `avatar-presign.ts` + `serializeUserMe` + integration in `users.ts`/`users-update.ts` (GET/PATCH refactor, no behavior change visibile)
2. Backend: `users-avatar.ts` con 3 handler + integration test
3. Docs: APPENDICE_A endpoints + APPENDICE_G codes
4. Frontend: `initials.ts` + `avatarCanvas.ts` (pure utils, easy test)
5. Frontend: `useAvatarUpload` hook + test
6. Frontend: `AvatarCropDialog` + test
7. Frontend: `AvatarSection` + test + ProfileForm integration
8. Frontend: `TopBar` augment + test
9. Smoke manuale dev (test mechanic + super_admin)
10. Deploy + smoke prod
