# Platform Admin Slice 1 — Create tenant + email invite — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `POST /v1/admin/tenants` (platform-admin only) that creates a Tenant + primary Location + `super_admin` Invitation under `withContext({ role: 'admin' })`, emails the onboarding magic-link to the owner via Resend, and a `admin-web` "Crea officina" form/confirmation page. Replaces the manual `scripts/rebuild-tenants.mjs` flow.

**Architecture:** New Fastify route `packages/api/src/routes/v1/admin-tenants-create.ts` mirroring `admin-me.ts` (guards) + `users-invitations-create.ts` (tx + audit + best-effort email). New `admin-web` page mirroring `packages/web/src/components/settings/TenantForm.tsx` (react-hook-form + zodResolver) and `pages/PlatformConsole.tsx` (useApiFetch). **Zero DB migration** — RLS write policies on `tenants`/`locations`/`invitations` already permit admin-context INSERT; `audit_logs.action` is free-form; all error codes already registered.

**Spec:** `docs/superpowers/specs/2026-06-28-platform-admin-slice1-create-tenant-design.md`

**Tech Stack:** Fastify + Zod + Prisma 7 (pg adapter) / Vite + React + react-hook-form + zod + shadcn/ui + vitest. Email via Resend (`deliverEmail` transport). Cognito via `getOfficineUserByEmail`.

**LOC budget:** target ~900 net (tests dominate), hard PR limit 1500. Check cumulative LOC after each task; halt and ask at ~80% (1200).

## Global Constraints

- **Node 22 via fnm** for any install/typecheck (`fnm env --shell powershell | iex; fnm use 22.22.2`); system Node 23 is rejected by Prisma preinstall.
- **Local gate = `pnpm -r typecheck` only** (pre-push hook). Do NOT run integration/infra tests locally (Docker freeze). After any route-handler change, run the targeted `pnpm --filter @garageos/api test:unit` (typecheck does not catch broken FakePrisma mocks).
- **Comments in English**; user-facing strings in **Italian** (admin-web has no i18n framework → inline Italian literals, same as `packages/web`).
- **No emoji** in code or commit messages. **Conventional Commits**, summary ≤72 chars (commitlint is a hard CI gate on every commit; scope from `api`/`web`/`admin-web`/`docs`).
- **No new dependencies** without justification (none needed — all libs already present).
- **Never weaken existing RLS policies** to make a test pass.

## Deviations from spec (verified against actual code — the code wins)

1. **Error code for duplicate VAT.** The arc spec proposed `admin.tenant.vat_already_exists`. The **registered** code in `APPENDICE_G:216` is `tenant.vat_number_duplicate` (409). Use the registered code; mint nothing.
2. **Email-only, no token in response.** This-slice decision (see design §"Decisions"): the response returns NO plaintext token; delivery is email-only via Resend. (Supersedes the arc spec's "return the magic-link".)
3. **Owner-email collision.** Resolved to reuse `user.invitation.email_in_other_tenant` (409, `APPENDICE_G`) via `getOfficineUserByEmail` — the exact pattern `users-invitations-create.ts:128-151` already uses.
4. **Audit `actorType`.** `AuditActorType` enum (`schema.prisma:212`) = `user | customer | system`. Platform admins have **no `User` row** (separate Cognito pool, no tenant). So `tenant_created` uses `actorType: 'system'`, `actorId: null`, and records the admin's Cognito `sub` in `metadata` — NOT `actorType: 'user'` as the officine invite does (`users-invitations-create.ts:218`).
5. **VAT validation is format-only (11 digits), not checksum.** Canonical validator `packages/database/src/validators/common.ts:39-41` `VatNumberSchema = z.string().regex(/^[0-9]{11}$/)`. Reuse the same regex; do NOT add an Italian checksum despite the `APPENDICE_G` "checksum" wording (consistency with the rest of the codebase; `tenant.factory.ts:23` also emits plain 11-digit VATs).
6. **No DB migration.** Confirmed: `tenants_write` / `locations_write` (`20260427120000…:91-94,108-111`) are `FOR ALL … WITH CHECK (is_admin_role() OR …)`; `invitations_tenant_isolation` (`20260424100000…:307-310`) is `FOR ALL` with `USING` doubling as the INSERT check; `is_admin_role()` (`…:45-50`) reads `app.current_role='admin'`, set by `withContext({ role:'admin' })`. `garageos_app` (NOBYPASSRLS) holds `GRANT INSERT` on all three. No CHECK constraints exist on `locations`/`tenants` address/VAT columns (only FK + vehicle/deadline/attachment CHECKs).

## Gotchas the implementer MUST respect (from project memory)

- **Cognito call OUTSIDE the Postgres tx** (`feedback_cognito_call_outside_postgres_tx`): the `getOfficineUserByEmail` pre-check runs before `withContext`; the email send runs after commit. Only the 3 inserts + audit are inside the tx (P2028 risk otherwise).
- **`withContext({})` empty context blocks writes** (`feedback_withcontext_empty_blocks_rls_writes`): you MUST pass `{ role: 'admin' as const }` — not `{}` — or the inserts are RLS-denied.
- **P2002 catch for duplicate VAT** (`tenants.vat_number @unique`, `schema.prisma:227`): wrap the tenant create and map `P2002` → `tenant.vat_number_duplicate` (409). Keep a defensive P2002 catch on the invitation create too (BR-206 index, even though a brand-new tenant has no prior pending invite).
- **Middleware must throw FastifyError, never `reply.send`** (`feedback_middleware_throw_fastifyerror_not_reply_send`): use `businessError(code, status, detail)` so the RFC7807 envelope is produced.
- **Integration test helpers mirror the exact wire** (`feedback_integration_test_mirror_frontend_wire`): `app.inject` must send `content-type: application/json` + JSON string body; assert exact serialized response shape.
- **Mocks thread dynamic input** (`feedback_integration_test_mock_dynamic_input`): the Cognito `exists` mock and email mock must be configured per-test, not hardcoded to one fixture.
- **No unit-test tautology** (`feedback_*`): assert `prisma.tenant.create` / `location.create` / `invitation.create` / `auditLog.create` were each called once with the expected `data`; the happy-path test must prove the email was called and the dup/collision tests must prove the insert path was NOT reached.
- **admin-web `api-client` 401 path** calls `onAuthExpired` (Slice 0 fix) — reuse `useApiFetch()`, do not hand-roll fetch.

## Branch

`feat/platform-admin-slice1-create-tenant` (already created; spec committed at `6d7bedd`).

## Pre-flight (run before dispatching implementers — confirm, don't assume)

- [ ] Grep `packages/database/src/index.ts` for a `VatNumberSchema` re-export. If exported, Task 1 may import it; otherwise use the inline regex `/^[0-9]{11}$/` (canonical source `validators/common.ts:41`). Plan code below uses the inline regex to stay self-contained.
- [ ] Confirm `request.jwt` shape on `requirePlatformAdminsPool` routes carries `sub`, `given_name`, `family_name`, `email` (it does in `admin-me.ts:22-27`).
- [ ] Confirm `env.COGNITO_OFFICINE_POOL_ID` is in the API env schema (it is — used at `users-invitations-create.ts:131`).
- [ ] Confirm `serializeInvitationAdmin`/`INVITATION_ADMIN_SELECT` are NOT needed here (we return a hand-built DTO, not the invitation admin DTO).
- [ ] Re-grep `APPENDICE_G` for the 4 reused codes: `tenant.vat_number_invalid` (400), `tenant.vat_number_duplicate` (409), `user.invitation.email_in_other_tenant` (409), `auth.cognito_unavailable` (502). No new codes.
- [ ] Confirm `server.ts:174` registers `adminMeRoutes`; insert `adminTenantsCreateRoutes` registration right after.

---

## Task 1: API — `POST /v1/admin/tenants` route + unit tests

**Files:**
- Create: `packages/api/src/routes/v1/admin-tenants-create.ts`
- Modify: `packages/api/src/server.ts` (import + `app.register(adminTenantsCreateRoutes)` after line 174)
- Test: `packages/api/tests/unit/routes/v1/admin-tenants-create.test.ts`

**Interfaces:**
- Consumes: `requireAuth`, `requirePlatformAdminsPool` (`../../middleware/…`); `businessError` (`../../lib/business-error.js`); `getOfficineUserByEmail`, `CognitoUnavailableError` (`../../lib/cognito.js`); `sendInvitationEmail` (`../../lib/ses-client.js`); `generateInvitationToken` (`../../lib/secure-tokens.js`); `Prisma` (`@garageos/database`); `env` (`../../config/env.js`); `app.withContext` (database plugin).
- Produces: `export const adminTenantsCreateRoutes: FastifyPluginAsync`.

**Behavioral contract:**

- Auth chain `preHandler: [requireAuth, requirePlatformAdminsPool]`. No `tenantContext`, no rate-limit config (platform admins are trusted internal staff; Slice 2 may add one).
- **Body Zod schema** (presence/type/length only; domain checks are manual for precise codes):
  ```ts
  const BodySchema = z.object({
    businessName: z.string().min(1).max(200).transform((s) => s.trim()),
    vatNumber: z.string().min(1).max(20).transform((s) => s.trim()),
    email: z.string().email().max(255).transform((s) => s.trim().toLowerCase()),
    ownerFirstName: z.string().min(1).max(100).transform((s) => s.trim()),
    ownerLastName: z.string().min(1).max(100).transform((s) => s.trim()),
    ownerEmail: z.string().email().max(255).transform((s) => s.trim().toLowerCase()),
  });
  ```
  On `safeParse` failure → `throw parsed.error` (error handler → 400). After parse, **manual VAT format check**: `if (!/^[0-9]{11}$/.test(body.vatNumber)) throw businessError('tenant.vat_number_invalid', 400, 'P.IVA non valida: deve essere di 11 cifre.')`.
- **Owner-email pre-check (OUTSIDE tx)** — mirror `users-invitations-create.ts:128-151`:
  ```ts
  let cognitoUser;
  try {
    cognitoUser = await getOfficineUserByEmail({ poolId: env.COGNITO_OFFICINE_POOL_ID, email: body.ownerEmail });
  } catch (err) {
    if (err instanceof CognitoUnavailableError) {
      throw businessError('auth.cognito_unavailable', 502, 'Servizio di autenticazione temporaneamente non disponibile.');
    }
    throw err;
  }
  if (cognitoUser.exists) {
    throw businessError('user.invitation.email_in_other_tenant', 409, "Questa email è già registrata in un'altra officina. Usa un altro indirizzo o contatta il supporto.");
  }
  ```
- **Transaction** `app.withContext({ role: 'admin' as const }, async (tx) => { … })`:
  1. `tx.tenant.create({ data: { businessName, vatNumber, email }, select: { id: true, businessName: true, vatNumber: true, status: true } })` — rely on schema defaults for `status/billingStatus/plan`. Wrap in try/catch: `P2002` → `businessError('tenant.vat_number_duplicate', 409, 'P.IVA già registrata.')`.
  2. `tx.location.create({ data: { tenantId: tenant.id, name: 'Sede principale', addressLine: 'Da definire', city: 'Da definire', province: 'NA', postalCode: '00100', country: 'IT', isPrimary: true } , select: { id: true } })`. (Placeholder values: NOT NULL + VarChar length only — no CHECK constraints. Workshop completes real data in onboarding wizard F-OFF-003.)
  3. Generate token + invitation:
     ```ts
     const { plaintext: tokenPlaintext, hash: tokenHash } = generateInvitationToken();
     const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
     let invitation;
     try {
       invitation = await tx.invitation.create({ data: {
         tenantId: tenant.id, invitationType: 'internal_user', targetEmail: body.ownerEmail,
         firstName: body.ownerFirstName, lastName: body.ownerLastName, role: 'super_admin',
         locationId: location.id, tokenHash, expiresAt,
       }, select: { id: true, expiresAt: true } });
     } catch (err) {
       if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
         throw businessError('user.invitation.duplicate_pending', 409, 'Esiste già un invito pendente per questa email.');
       }
       throw err;
     }
     ```
  4. Audit (same tx, atomic rollback):
     ```ts
     await tx.auditLog.create({ data: {
       tenantId: tenant.id, actorType: 'system', actorId: null, action: 'tenant_created',
       entityType: 'tenant', entityId: tenant.id,
       metadata: { actorCognitoSub: request.jwt?.sub ?? null, ownerEmail: body.ownerEmail, vatNumber: body.vatNumber },
       ipAddress: request.ip,
     }});
     ```
  5. Return `{ tenant, invitation, tokenPlaintext }` to the handler scope (token never hits the DB row beyond its hash, never the response).
- **Email (best-effort, OUTSIDE tx)** — wrap in try/catch, set `emailSent`:
  ```ts
  const jwt = request.jwt!;
  const adminName = [jwt.given_name, jwt.family_name].filter(Boolean).join(' ') || 'GarageOS';
  const WEB_BASE_URL = process.env.WEB_BASE_URL ?? 'https://app.garageos.aifollyadvisor.com';
  let emailSent = true;
  try {
    await sendInvitationEmail({
      toAddress: body.ownerEmail, invitedFirstName: body.ownerFirstName, invitedByName: adminName,
      tenantName: body.businessName, role: 'super_admin',
      magicLinkUrl: `${WEB_BASE_URL}/invitations/${tokenPlaintext}`,
    });
  } catch (err) {
    emailSent = false;
    request.log.error({ err, tenantId: tenant.id }, 'tenant invite email send failed (best-effort, tenant persisted)');
  }
  ```
- **Response 201** (hand-built DTO — NO token):
  ```ts
  return reply.code(201).send({
    tenant: { id: tenant.id, businessName: tenant.businessName, vatNumber: tenant.vatNumber, status: tenant.status },
    invitation: { ownerEmail: body.ownerEmail, expiresAt: invitation.expiresAt, emailSent },
  });
  ```

**Module header comment** (English): cite the decisions — email-only via Resend, no token in response; `actorType:'system'` because platform admins have no tenant User row; Cognito pre-check out-of-tx.

**Unit tests** (FakePrisma pattern from `tests/unit/routes/v1/customers-create.test.ts`; mock `jwtVerifier` → `{ pool: 'platform-admins', payload: { sub, token_use:'id', given_name, family_name, email } }`; mock `withContext` as `(_ctx, fn) => fn(prisma)`; mock `../../lib/cognito.js` `getOfficineUserByEmail` and `../../lib/ses-client.js` `sendInvitationEmail`). Cases (TDD red→green):
1. No `Authorization` → 401.
2. `officine` pool token → 403 (guard).
3. `clienti` pool token → 403 (guard).
4. Missing `businessName` → 400 (Zod).
5. `vatNumber` not 11 digits → 400 code `tenant.vat_number_invalid`; assert `prisma.tenant.create` NOT called.
6. Happy path → 201; assert `tenant.create`, `location.create` (with `isPrimary:true`, `name:'Sede principale'`), `invitation.create` (with `role:'super_admin'`, `invitationType:'internal_user'`), `auditLog.create` (with `action:'tenant_created'`, `actorType:'system'`) each called once; assert `sendInvitationEmail` called with `magicLinkUrl` ending `/invitations/<token>` and `role:'super_admin'`; assert response body has `invitation.emailSent === true` and **no `token` field**.
7. `getOfficineUserByEmail` resolves `{ exists: true }` → 409 `user.invitation.email_in_other_tenant`; assert `tenant.create` NOT called.
8. `getOfficineUserByEmail` throws `CognitoUnavailableError` → 502 `auth.cognito_unavailable`.
9. `tenant.create` rejects `P2002` → 409 `tenant.vat_number_duplicate`.
10. `sendInvitationEmail` rejects → still 201, `invitation.emailSent === false`; assert tenant create still happened.

- [ ] **Step 1:** Write `admin-tenants-create.test.ts` with the 10 cases (red).
- [ ] **Step 2:** Run `pnpm --filter @garageos/api test:unit -- admin-tenants-create` → FAIL (route missing).
- [ ] **Step 3:** Implement `admin-tenants-create.ts` per the contract.
- [ ] **Step 4:** Register in `server.ts` after `adminMeRoutes`.
- [ ] **Step 5:** Run the unit test → PASS; run `pnpm --filter @garageos/api typecheck`.
- [ ] **Step 6:** Commit `feat(api): add POST /v1/admin/tenants create-tenant endpoint`.

---

## Task 2: API — integration tests (RLS admin-context write + isolation + audit)

**Files:**
- Test: `packages/api/tests/integration/admin-tenants-create.test.ts`

**Interfaces:**
- Consumes: `buildTestServer()` (`./fixtures.js`), `signTestToken` (`../helpers/jwt.js`), `resetDb`, `createTenantWithLocation`, `createUser` (`./helpers.js`), `pgAdmin` (`./setup.js`); AWS SDK client mocks `mockClient(CognitoIdentityProviderClient)` + `mockClient(SESv2Client)` and `_resetCognitoClientForTests` / `_resetSesClientForTests` (pattern from `tests/integration/users-invitations-create.test.ts:23-52`).

**Why integration (Tier 1):** this is the load-bearing gate — proves the admin-context write actually passes RLS under the real `garageos_app` role (the unit test mocks `withContext`), and that isolation holds. CI-only (Docker).

**Cases:**
1. **Isolation matrix** (mirror `admin-me.test.ts`): no auth → 401; `officine` token → 403; `clienti` token → 403 on `POST /v1/admin/tenants`. (Reuse `signTestToken({ pool })`.) Plus the reverse already covered by `admin-me.test.ts` (platform-admins on tenant route → 403) — add one assertion that a `platform-admins` token is rejected 403 on an existing tenant route, e.g. `POST /v1/customers`, to lock the bidirectional boundary.
2. **Happy path** (platform-admins token; Cognito mock `AdminGetUserCommand.rejects(UserNotFoundException)` → `exists:false`; SES/Resend send mock resolves): POST a valid body → 201. Then assert via `pgAdmin.query`:
   - `tenants` row exists with the VAT, `status='active'`, `billing_status='manual'`, `plan='starter'`.
   - `locations` row exists for that tenant with `is_primary=true`, `name='Sede principale'`.
   - `invitations` row exists with `invitation_type='internal_user'`, `role='super_admin'`, `location_id` = the primary location, `token_hash` non-null, `accepted_at IS NULL`, `expires_at` ~ now+7d.
   - `audit_logs` row exists with `action='tenant_created'`, `actor_type='system'`, `entity_id` = tenant id.
   - Response body: `invitation.emailSent === true`, no `token` field. Cognito mock called for the owner email; email send mock called once.
3. **Duplicate VAT** → 409 `tenant.vat_number_duplicate`: pre-seed a tenant with VAT `X` (via `pgAdmin` or a first successful POST), then POST again with the same VAT → assert 409 and that no second tenant row was created.
4. **Owner-email in other tenant** → 409 `user.invitation.email_in_other_tenant`: configure Cognito mock `AdminGetUserCommand.resolves({...})` (exists) → assert 409 and NO tenant/location/invitation rows written (RLS write path not reached).
5. **VAT invalid format** → 400 `tenant.vat_number_invalid` (e.g. `vatNumber: 'ABC'`).

**RLS guard assertion:** after the happy path, run a tenant-scoped negative still holds — e.g. with `withContext`-less raw `garageos_app` connection if available, OR simply assert the existing isolation tests are unaffected (don't weaken policies). Document that no policy SQL changed.

- [ ] **Step 1:** Write the integration test with the 5 case groups (red — endpoint exists from Task 1, so happy path may pass; isolation/dup/collision assertions drive correctness).
- [ ] **Step 2:** Note: do NOT run locally (Docker). Push and let CI run it. Locally only `pnpm --filter @garageos/api typecheck`.
- [ ] **Step 3:** Commit `test(api): integration tests for admin create-tenant (rls, isolation, audit)`.

---

## Task 3: admin-web — "Crea officina" form + confirmation page + tests

**Files:**
- Create: `packages/admin-web/src/lib/validators/tenant-create.ts` (Zod schema + types)
- Create: `packages/admin-web/src/pages/CreateTenant.tsx` (form + confirmation states)
- Modify: `packages/admin-web/src/App.tsx` (add protected route `/officine/nuova` → `<CreateTenant />`)
- Modify: `packages/admin-web/src/pages/PlatformConsole.tsx` (add a nav `<Button>`/link to `/officine/nuova`)
- Test: `packages/admin-web/tests/create-tenant.test.tsx`

**Interfaces:**
- Consumes: `useApiFetch()` (`../lib/api-client`), `ApiError` (`../lib/api-client`), shadcn `Button/Input/Label/Card*` (`../components/ui/*`), `useForm`+`zodResolver` (react-hook-form / @hookform/resolvers — confirm present in `packages/web`; if absent in admin-web deps, prefer plain `useState` controlled inputs to avoid adding a dep — see pre-flight). `react-router` `useNavigate`.
- Produces: route `/officine/nuova`.

**Pre-flight for this task:** grep `packages/admin-web/package.json` for `react-hook-form` + `@hookform/resolvers`. If present → mirror `packages/web/src/components/settings/TenantForm.tsx`. If ABSENT → do NOT add deps; implement with controlled `useState` + manual validation mirroring the Zod rules (the form is 6 simple fields). Pick one and keep the test aligned.

**Validation schema** (`tenant-create.ts`) — mirror the API body, Italian messages:
```ts
export const createTenantSchema = z.object({
  businessName: z.string().trim().min(1, 'Ragione sociale obbligatoria').max(200),
  vatNumber: z.string().trim().regex(/^[0-9]{11}$/, 'P.IVA: 11 cifre'),
  email: z.string().trim().toLowerCase().email('Email non valida').max(255),
  ownerFirstName: z.string().trim().min(1, 'Nome obbligatorio').max(100),
  ownerLastName: z.string().trim().min(1, 'Cognome obbligatorio').max(100),
  ownerEmail: z.string().trim().toLowerCase().email('Email titolare non valida').max(255),
});
```

**Component behavior** (`CreateTenant.tsx`):
- Renders a `<Card>` titled "Crea officina" with 6 labelled inputs (businessName "Ragione sociale", vatNumber "P.IVA", email "Email officina", ownerFirstName "Nome titolare", ownerLastName "Cognome titolare", ownerEmail "Email titolare").
- Submit: validate client-side; call `apiFetch('/v1/admin/tenants', { method:'POST', body: JSON.stringify(values) })` via `useApiFetch()`.
- On success (`201`): switch to a **confirmation** view — heading "Officina creata", body "**{businessName}** creata. Invito inviato a **{ownerEmail}**. Il link di accesso scade tra 7 giorni." If `res.invitation.emailSent === false`, render a warning line: "⚠ Email non inviata. Il re-invio del link sarà disponibile a breve (Slice 2); nel frattempo contatta il supporto." Show a "Crea un'altra officina" button that resets to the form.
- On `ApiError`: map known codes to inline Italian messages — `tenant.vat_number_duplicate` → "P.IVA già registrata."; `tenant.vat_number_invalid` → "P.IVA non valida (11 cifre)."; `user.invitation.email_in_other_tenant` → "Email titolare già usata in un'altra officina."; `auth.cognito_unavailable` → "Servizio temporaneamente non disponibile, riprova."; fallback → the `ApiError.message`. Render in an alert region (`role="alert"`). Disable submit while pending.
- Wire from `PlatformConsole`: a `<Button>` "Crea officina" → `navigate('/officine/nuova')`.

**Tier-2 tests** (2–3, vitest + jsdom; mock `useApiFetch` + `useAuth` like `tests/platform-console.test.tsx`; wrap in `MemoryRouter`):
1. **Happy path:** fill all fields, submit → `apiFetch` called once with POST `/v1/admin/tenants` and the JSON body; on resolve `{ tenant:{businessName}, invitation:{ ownerEmail, emailSent:true } }` → confirmation text "Invito inviato a {ownerEmail}" appears.
2. **Error state:** `apiFetch` rejects `new ApiError('tenant.vat_number_duplicate', 409, '…')` → alert shows "P.IVA già registrata." and the form is still present.
3. **emailSent=false branch:** resolve with `emailSent:false` → confirmation shows the ⚠ warning line.

No pure-rendering tests.

- [ ] **Step 1:** Pre-flight grep deps; write `create-tenant.test.tsx` (red).
- [ ] **Step 2:** Run `pnpm --filter @garageos/admin-web test -- create-tenant` → FAIL.
- [ ] **Step 3:** Implement schema + `CreateTenant.tsx`; wire route + PlatformConsole link.
- [ ] **Step 4:** Run the test → PASS; `pnpm --filter @garageos/admin-web typecheck` + `build`.
- [ ] **Step 5:** Commit `feat(admin-web): crea-officina form and confirmation page`.

---

## Task 4: Docs + secret field fix

**Files:**
- Modify: `docs/APPENDICE_A_API.md` — add `POST /v1/admin/tenants` (body, 201 shape, errors `tenant.vat_number_invalid`/`tenant.vat_number_duplicate`/`user.invitation.email_in_other_tenant`/`auth.cognito_unavailable`); fix the officine-invite note that says "via SES" → "via Resend".
- Modify: `docs/APPENDICE_C_INFRASTRUCTURE.md` — note tenants are now created via the admin console (`POST /v1/admin/tenants`), `rebuild-tenants.mjs` reserved for disaster recovery; mention Resend is the prod email provider.
- Modify: `infrastructure/README.md` — add `RESEND_API_KEY` to the documented app-secret field list (F7 section currently lists 9 keys and omits it — the code requires it: `transport.ts:70`).

**Behavioral contract:** docs only, no code. Keep the APPENDICE_A entry consistent with the actual response DTO from Task 1 (no token field; `invitation.emailSent`).

- [ ] **Step 1:** Edit the three docs.
- [ ] **Step 2:** Commit `docs: document admin create-tenant endpoint and resend secret key`.

---

## Self-review (done at plan time)

- **Spec coverage:** endpoint (T1), email-only Resend delivery (T1), owner-email pre-check (T1/T2), zero-migration RLS write (T2), audit (T1/T2), isolation negatives (T2), admin-web form+confirmation (T3), Tier-2 tests (T3), Tier-1 contract/RLS/audit (T1/T2), doc fixes incl. RESEND_API_KEY (T4). All design sections map to a task. ✔
- **Deferred (Slice 2), intentionally absent:** resend/regenerate link, tenant list, lifecycle. ✔
- **Type consistency:** response DTO `{ tenant:{id,businessName,vatNumber,status}, invitation:{ownerEmail,expiresAt,emailSent} }` is identical in T1 (route), T1 unit test, T2 integration assertions, and T3 form consumption. Error codes identical across T1/T2/T3/T4. ✔
- **Placeholder scan:** none — all values/regexes/strings are concrete. ✔

## Review gates (in order)

1. Per-task review (subagent-driven): T1 + T2 are the security/new-public-API-surface tasks → review each. T3/T4 covered by the final gate.
2. `pnpm -r typecheck` (pre-push) — mandatory local gate.
3. **Final whole-branch `/code-review high`** — load-bearing, never skip.
4. CI full matrix (`gh pr checks --watch`) — the only gate for RLS semantics + real-Postgres integration (T2).
5. **Browser smoke (BLOCKER, UI-facing):** on `admin.garageos.aifollyadvisor.com` (or local admin-web) log in as platform admin → "Crea officina" → submit a test tenant → confirmation shows; verify the owner receives the Resend email and the magic-link lands on the officine app accept screen. No review replaces this.
