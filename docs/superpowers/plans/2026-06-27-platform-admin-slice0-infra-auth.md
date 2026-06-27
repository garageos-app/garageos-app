# Platform Admin — Slice 0 (Infra & Auth) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the foundation for the platform-admin console: a third Cognito pool `garageos-platform-admins` (no tenant identity), a new `packages/admin-web` Vite app served on `admin.garageos.aifollyadvisor.com`, and an API auth-plugin that verifies platform-admin JWTs and guards a `/v1/admin/*` prefix. End state: a platform admin can log into the admin app (forced password change on first login) and reach exactly one route — `GET /v1/admin/me`. No tenant features yet (that is Slice 1).

**Architecture:** Reuse, don't duplicate. The API gains a *third verifier branch* in the existing `src/plugins/auth.ts` (mirrors the officine/clienti pattern) and a `require-platform-admins-pool` guard (mirrors `require-officina-pool.ts`). Infra extends the existing `CognitoConstruct` and generalizes `WebStack`/`WebCertStack` to host a second subdomain. `admin-web` mirrors the `packages/web` scaffold and auth (`AuthContext` + `amazon-cognito-identity-js` SRP), adding the one thing officine-web lacks: a `NEW_PASSWORD_REQUIRED` challenge flow for temp-password bootstrap.

**Spec:** `docs/superpowers/specs/2026-06-27-platform-admin-tenant-provisioning-design.md`

**LOC budget:** target ~900-1200 net, hard PR limit 1500. **Natural PR split** if size demands: PR-A = Tasks 1-7 (infra + API), PR-B = Tasks 8-12 (admin-web + CLI + CI/docs). Controller checks cumulative LOC after each task; halt and ask at ~80% (1200) if shipping as one PR.

---

## Deviations from spec (verified against actual code — the code wins)

1. **New API env vars are OPTIONAL, not required.** The spec implies adding required Cognito env vars. The cognito-trigger Lambda (`packages/api/src/cognito-triggers/index.ts:38-43`) reuses `parseEnv()` transitively, and both Lambdas read the SAME secret. Adding **required** vars would crash every cold start (trigger + API) in the window between merging the code and the operator populating the secret — exactly the #217 failure mode (`memory/feedback_lambda_reuses_api_env_schema_needs_all_vars.md`). Making them `.optional()` + building the third verifier **conditionally** decouples deploy ordering: the API keeps booting; `/v1/admin/*` simply returns 401 (unknown issuer) until the secret is populated.

2. **No new Lambda IAM.** Verifying a Cognito JWT needs only an HTTPS JWKS fetch — no `cognito-idp:*` action. Slice 0 adds nothing to `lambda-api.ts` IAM. (The bootstrap CLI in Task 11 calls `AdminCreateUser`, but it runs locally with the operator's own AWS creds, not the Lambda role.) Contrast the recurring IAM-gap memory (`feedback_lambda_iam_cognito_signup_gap.md`) — it does not apply here.

3. **New secret fields need no `addEnvironment`.** Unlike `S3_ATTACHMENTS_BUCKET` (a bucket name not in the secret, wired via `addEnvironment` in `main-stack.ts:88`), the platform-admins pool/client IDs live in the `garageos/production/app` secret and reach both Lambdas through `loadSecretsIntoEnv()`. Just add the two fields to `SecretsConstruct`.

4. **Bootstrap = temporary password** (confirmed with user), printed once by the CLI; admin is forced to change it on first login. Not a magic-link.

## Gotchas the implementer MUST respect (from project memory)

- **Vite Cognito global shim** (`feedback_vite_cognito_global_shim.md`): `admin-web/vite.config.ts` MUST keep `define: { global: 'globalThis' }` or `amazon-cognito-identity-js` crashes at module init. Browser-console smoke is mandatory.
- **Cognito SRP needs `getRandomValues`** only in Expo/bridgeless (`feedback_cognito_srp_expo_go_bridgeless.md`) — that is mobile-only; the browser already provides `crypto.getRandomValues`. Not applicable to admin-web, do NOT add the Metro alias.
- **Infra count assertions** (`feedback_infra_schedule_count_assertion_cascade.md`): adding a Cognito pool/client/S3 bucket/CloudFront distribution breaks `resourceCountIs` in `infrastructure/tests/`. Update every affected count in lockstep (Task 1, 2, 3).
- **pnpm hoisted for the workspace** (`feedback_pnpm_strict_expo_workspace.md`): admin-web is a plain Vite app (not Expo). No `.npmrc` per-workspace tweaks; it inherits the root. Verify `react`/`@types/react` resolve to the single hoisted v19 — do not pin a second copy.
- **PowerShell UTF-16 BOM** (`feedback_powershell_utf16_npmrc.md`): when creating any dotfile (`.env.example`, `.gitignore`) on Windows, write UTF-8 (the Write tool does this; do not pipe through `Out-File`).
- **No emoji in code/commits.** Comment headers in English; user-facing strings in Italian.
- **Self-merge preconditions** (`feedback_self_merge_authorized.md`): CI green + final `/code-review high` + zero open questions. The admin-web PR is UI/shell-facing → **smoke runbook is a BLOCKER** (`feedback_smoke_mandatory_for_shell_layout_pr.md`).

## Branch

`feat/platform-admin-slice0-infra-auth` (single branch; if split into two PRs, branch the second as `feat/platform-admin-slice0-admin-web` off the merged first).

---

## Pre-flight checklist (run BEFORE dispatching implementers)

### Schema & Prisma
- [ ] Slice 0 touches **no** Prisma models. Confirm: `GET /v1/admin/me` reads only JWT claims, no DB. (Tenant creation + DB writes are Slice 1.)

### Docs cross-reference (BR / error codes / API)
- [ ] Grep `APPENDICE_G` for `FORBIDDEN` / `UNAUTHORIZED` — the guard reuses the existing `FORBIDDEN` envelope (CamelCase→SNAKE via error-handler); no new error code is minted in Slice 0. Confirm before inventing `admin.*` codes.
- [ ] Grep `APPENDICE_A_API.md` for `/v1/admin` — confirm no prior definition; add the `GET /v1/admin/me` row (Task 12).
- [ ] Grep for target files before "Create": `packages/admin-web/`, `packages/api/src/middleware/require-platform-admins-pool.ts`, `packages/api/src/routes/v1/admin-me.ts`, `scripts/admin/create-platform-admin.ts`, `.github/workflows/deploy-admin-web.yml` — all expected absent.

### RLS & DB constraints
- [ ] N/A for Slice 0 (no DB access). The cross-tenant RLS decision is deferred to the Slice 1 plan.

### Tests & refactors
- [ ] `tests/helpers/jwt.ts`: adding a `'platform-admins'` pool means a third key pair + a third `HANDOFF_ENV` bundle in `globalSetup`. Grep every `TestPool` use — it is a union type; the switch over pools must stay exhaustive.
- [ ] Route-handler/middleware changes: run `pnpm --filter @garageos/api test:unit` locally after Tasks 5-7 (typecheck misses FakePrisma/mocked-verifier breakage).

### Infra & runbooks
- [ ] Grep `infrastructure/tests/` for `resourceCountIs('AWS::Cognito::UserPool'` (currently `2`), `'AWS::Cognito::UserPoolClient'`, `'AWS::S3::Bucket'`, `'AWS::CloudFront::Distribution'` — bump each affected count.
- [ ] Grep `infrastructure/tests/` for a secrets test asserting the secret's field set/count — update if present (Task 3).
- [ ] New migrations: none. `deploy.yml` ships CDK only; the new `deploy-admin-web.yml` (Task 12) mirrors `deploy-web.yml` and is operator/CI-driven.
- [ ] Runbook commands cross-reference `--stack-name` with `bin/garageos.ts` (new stacks `GarageosAdminWebCertStack`, `GarageosAdminWebStack`); PowerShell-safe.

### Style & process
- [ ] English comment headers; Italian UI strings. No emoji.

---

## Task 1: Cognito `platform-admins` pool (infra)

**Files:**
- Modify: `infrastructure/lib/constructs/cognito.ts`
- Modify: `infrastructure/lib/stacks/main-stack.ts` (CfnOutputs)
- Test: `infrastructure/tests/cognito.test.ts`

**Interfaces — Produces:**
- `CognitoConstruct.platformAdminsUserPool: cognito.UserPool`
- `CognitoConstruct.platformAdminsClient: cognito.UserPoolClient`

**Contract:**
- New pool `garageos-${props.environment}-platform-admins`. Mirror the officine pool (`cognito.ts:44-70`) with these differences: **no `customAttributes`** (no tenant_id/location_id/role — platform admins belong to no tenant), `selfSignUpEnabled: false`, `signInAliases: { email: true }`, standard attributes email/givenName/familyName required+mutable, password policy identical to officine (`minLength: 10`, lower+upper+digits, no symbols), `accountRecovery: EMAIL_ONLY`, `mfa: cognito.Mfa.OFF` (bootstrap simplicity; MFA is a later slice), `removalPolicy: RETAIN`.
- App client `garageos-platform-admins-client`: `authFlows: { userSrp: true, userPassword: true }`, token validity matching officine (access/id 1h, refresh 30d), `preventUserExistenceErrors: true`, **no `oAuth`**, no `supportedIdentityProviders` beyond COGNITO, **no triggers**.
- Add two `CfnOutput`s in `main-stack.ts` mirroring the officine ones: `CognitoPlatformAdminsUserPoolId`, `CognitoPlatformAdminsClientId`, each with a description noting it populates the `garageos/production/app` secret keys `COGNITO_PLATFORM_ADMINS_POOL_ID` / `_CLIENT_ID`.

**Steps (TDD red → green):**
- [ ] **Step 1** — Update `cognito.test.ts`: bump `resourceCountIs('AWS::Cognito::UserPool', 2)` → `3` and the `UserPoolClient` count accordingly; add a test asserting `UserPoolName: 'garageos-production-platform-admins'` with `AdminCreateUserConfig.AllowAdminCreateUserOnly: true`; add a test asserting the platform-admins pool's `Schema` does **not** contain a `tenant_id`/`role` custom attribute (find the pool by name via `findResources` + filter, assert no `Name: 'tenant_id'` in its Schema). Run: `pnpm --filter @garageos/infrastructure test` → FAIL.
- [ ] **Step 2** — Implement the pool + client + outputs. Run the infra test → PASS.
- [ ] **Step 3** — `pnpm --filter @garageos/infrastructure typecheck`.
- [ ] **Step 4** — Commit: `feat(infra): add platform-admins cognito pool`

---

## Task 2: Host admin web on `admin.` subdomain (infra)

**Files:**
- Modify: `infrastructure/lib/config/production.ts` (config interface + value)
- Modify: `infrastructure/lib/stacks/web-stack.ts` (parameterize subdomain + bucket)
- Modify: `infrastructure/lib/stacks/web-cert-stack.ts` (parameterize subdomain)
- Modify: `infrastructure/bin/garageos.ts` (instantiate admin cert + web stacks)
- Test: `infrastructure/tests/web-hosting.test.ts` (unchanged construct test still passes; add admin synth coverage if cheap)

**Interfaces — Produces:** two new stacks `GarageosAdminWebCertStack` (us-east-1), `GarageosAdminWebStack` (eu-central-1).

**Contract:**
- Config: add `adminSubdomain: 'admin'` and `adminBucketName: 'garageos-production-web-admin'` to `EnvironmentConfig` + `productionConfig`.
- `WebCertStack`: rename the `appSubdomain` prop to a generic `subdomain` (it already takes `domainName` + `synthMock`). Update the existing `bin` call to pass `subdomain: productionConfig.appSubdomain`.
- `WebStack`: replace internal reads of `config.appSubdomain`/`config.webBucketName` with explicit props `subdomain: string` + `bucketName: string`; keep `config` for `synthMock`/`domainName`. Update the existing app call to pass `subdomain: config.appSubdomain`, `bucketName: config.webBucketName`. **Construct child id `'WebHosting'` and the `CfnOutput` ids are identical across two stack instances — that is fine because they live in different stacks**, but make the output *descriptions* generic.
- `bin/garageos.ts`: after the existing app stacks, instantiate `GarageosAdminWebCertStack` (region us-east-1, `crossRegionReferences: true`, `subdomain: productionConfig.adminSubdomain`) and `GarageosAdminWebStack` (region eu-central-1, `crossRegionReferences: true`, `subdomain: adminSubdomain`, `bucketName: adminBucketName`, `appCertificate: <admin cert>`).

**Steps:**
- [ ] **Step 1** — Update `web-hosting.test.ts` only if it asserts a hardcoded `app.example.com` alias in a way the refactor changes (it builds the construct directly, so it should still pass unchanged — verify). Add no count regressions.
- [ ] **Step 2** — Apply config + stack parameterization + bin wiring.
- [ ] **Step 3** — `CDK_SYNTH_MOCK=true pnpm --filter @garageos/infrastructure synth` succeeds and emits 4 stacks + the 2 admin stacks (6 total). `pnpm --filter @garageos/infrastructure test` green.
- [ ] **Step 4** — Commit: `feat(infra): host admin web app on admin subdomain`

---

## Task 3: Platform-admins IDs in app secret (infra)

**Files:**
- Modify: `infrastructure/lib/constructs/secrets.ts`
- Test: `infrastructure/tests/` secrets test if one exists (else none)

**Contract:** add `COGNITO_PLATFORM_ADMINS_POOL_ID` and `COGNITO_PLATFORM_ADMINS_CLIENT_ID` to `secretObjectValue` with `REPLACE_AFTER_DEPLOY` placeholders; update the "seven fields" header comment to "nine". No `addEnvironment`, no IAM (see Deviations 2-3).

**Steps:**
- [ ] **Step 1** — If a secrets test asserts the field set, add the two keys to its expectation → FAIL, then implement → PASS. If no such test, implement directly.
- [ ] **Step 2** — `pnpm --filter @garageos/infrastructure test` + `typecheck` green.
- [ ] **Step 3** — Commit: `feat(infra): add platform-admins cognito ids to app secret`

---

## Task 4: Optional platform-admins env vars (API)

**Files:**
- Modify: `packages/api/src/config/env.ts`
- Test: `packages/api/tests/unit/config/env.test.ts` (mirror existing if present; else add a focused test)

**Contract — verbatim (the regex is the point):**
```ts
COGNITO_PLATFORM_ADMINS_POOL_ID: z
  .string()
  .regex(
    /^[a-z]{2}-[a-z]+-\d_[A-Za-z0-9]+$/,
    'COGNITO_PLATFORM_ADMINS_POOL_ID must match `<region>_<id>`',
  )
  .optional(),
COGNITO_PLATFORM_ADMINS_CLIENT_ID: z.string().min(1).optional(),
COGNITO_PLATFORM_ADMINS_JWKS_URL_OVERRIDE: z.string().url().optional(),
```
All three `.optional()` — see Deviation 1.

**Steps:**
- [ ] **Step 1** — Test: `parseEnv` succeeds with NONE of the three set (proves optional); and succeeds + surfaces them when set; and rejects a malformed pool id when set. Run → FAIL.
- [ ] **Step 2** — Add the fields. Run → PASS.
- [ ] **Step 3** — Commit: `feat(api): add optional platform-admins cognito env vars`

---

## Task 5: Third verifier branch in auth plugin (API)

**Files:**
- Modify: `packages/api/src/plugins/auth.ts`
- Test: `packages/api/tests/unit/plugins/auth.test.ts` (or wherever the verifier is unit-tested; mirror existing)

**Interfaces — Produces:** `AuthPool` widened to `'officine' | 'clienti' | 'platform-admins'`; `AuthPluginOptions.platformAdminsJwks?: JWK[]`.

**Contract:**
- Widen `AuthPool` (auth.ts:10). The `require-auth` middleware and the `FastifyRequest.authPool` declaration already key off `AuthPool`, so they widen transitively.
- In `buildVerifier`, build the third verifier **only when configured**:
```ts
const platformAdminsConfigured =
  !!env.COGNITO_PLATFORM_ADMINS_POOL_ID && !!env.COGNITO_PLATFORM_ADMINS_CLIENT_ID;

const platformAdminsVerifier = platformAdminsConfigured
  ? makePoolVerifier(
      env.COGNITO_PLATFORM_ADMINS_POOL_ID!,
      env.COGNITO_PLATFORM_ADMINS_CLIENT_ID!,
      env.COGNITO_PLATFORM_ADMINS_JWKS_URL_OVERRIDE,
    )
  : undefined;

if (platformAdminsVerifier && opts.platformAdminsJwks?.length) {
  platformAdminsVerifier.cacheJwks({ keys: opts.platformAdminsJwks } as never);
}
const platformAdminsIss = platformAdminsConfigured
  ? cognitoIssuer(env.COGNITO_PLATFORM_ADMINS_POOL_ID!)
  : undefined;
```
- Add the routing branch in `verify()` BEFORE the final throw:
```ts
if (platformAdminsVerifier && iss === platformAdminsIss) {
  const payload = (await platformAdminsVerifier.verify(token)) as CognitoIdTokenPayload;
  return { pool: 'platform-admins', payload };
}
```
When not configured, a platform-admins token falls through to `throw new Error('Unknown issuer')` → `require-auth` maps it to 401. Correct and safe.

**Steps:**
- [ ] **Step 1** — Unit test: with `platformAdminsJwks` seeded + the env vars set on the test `env`, `verify()` returns `pool: 'platform-admins'` for a token from that issuer; an officine token still returns `officine`; an unknown issuer still throws. (Mirror how officine/clienti are unit-tested — they pass JWKs via `AuthPluginOptions`.) Run → FAIL.
- [ ] **Step 2** — Implement. Run → PASS. Run `pnpm --filter @garageos/api test:unit` (verifier + require-auth).
- [ ] **Step 3** — Commit: `feat(api): verify platform-admins pool jwts in auth plugin`

---

## Task 6: `require-platform-admins-pool` guard (API)

**Files:**
- Create: `packages/api/src/middleware/require-platform-admins-pool.ts`
- Test: `packages/api/tests/unit/middleware/require-platform-admins-pool.test.ts`

**Interfaces — Produces:** `export async function requirePlatformAdminsPool(request, reply): Promise<void>`.

**Contract:** mirror `require-officina-pool.ts` exactly. Import the same `forbiddenError` helper it imports (grep `require-officina-pool.ts` for the import path). Reject when `request.authPool !== 'platform-admins'` with an English detail (e.g. `'This endpoint is restricted to platform administrators'`) so the error-handler emits the `FORBIDDEN` envelope. No tenant-context dependency (platform admins have no tenant claims).

**Steps:**
- [ ] **Step 1** — Test (mirror `require-officina-pool.test.ts`): passes through when `authPool === 'platform-admins'` (200); returns 403 `FORBIDDEN` Problem Details when `authPool === 'officine'` and when `'clienti'`. Run → FAIL.
- [ ] **Step 2** — Implement. Run → PASS.
- [ ] **Step 3** — Commit: `feat(api): add require-platform-admins-pool guard`

---

## Task 7: `GET /v1/admin/me` route + auth isolation tests (API) — RISKIEST, per-task review

**Files:**
- Create: `packages/api/src/routes/v1/admin-me.ts`
- Modify: `packages/api/src/server.ts` (register the route after the auth plugin)
- Modify: `packages/api/tests/helpers/jwt.ts` (add `'platform-admins'` pool support)
- Modify: the integration test global setup/key-handoff that seeds JWKs + env for the test app (grep for where `officineJwks`/`COGNITO_OFFICINE_JWKS_URL_OVERRIDE` are wired in tests)
- Test: `packages/api/tests/integration/admin-me.test.ts`

**Interfaces — Consumes:** `requireAuth` (`middleware/require-auth.ts`), `requirePlatformAdminsPool` (Task 6). **Produces:** route `GET /v1/admin/me`.

**Contract:**
- Handler: `preHandler: [requireAuth, requirePlatformAdminsPool]`. Returns `200` with `{ sub, email, firstName, lastName }` read from `request.jwt` (`sub`, `email`, `given_name`, `family_name`). No DB, no tenant context. Wire shape is the response body above — keep it minimal and stable; Slice 2 may extend.
- `tests/helpers/jwt.ts`: extend `TestPool` to include `'platform-admins'`; add its issuer/poolId framing and a third key pair in `globalSetup` with a `HANDOFF_ENV.platformAdmins` bundle (mirror the officine/clienti handoff at jwt.ts:57-115). For the platform-admins pool, sign tokens with NO custom claims (just `sub`, `email`, `given_name`, `family_name`, `token_use: 'id'`).
- Integration harness: build the test app with `platformAdminsJwks` seeded AND `COGNITO_PLATFORM_ADMINS_POOL_ID` / `_CLIENT_ID` set in the test env so `platformAdminsConfigured` is true (Task 5). Grep the existing integration `buildServer`/test bootstrap to mirror how officine/clienti JWKs + override env are injected.

**Steps:**
- [ ] **Step 1** — Integration test `admin-me.test.ts`: (a) `signTestToken({ pool: 'officine' })` → `GET /v1/admin/me` → **403** `FORBIDDEN`; (b) `pool: 'clienti'` → **403**; (c) `pool: 'platform-admins'` with `email`/`given_name`/`family_name` claims → **200** echoing `{ sub, email, firstName, lastName }`; (d) no Authorization header → **401**. Run → FAIL.
- [ ] **Step 2** — Extend `jwt.ts` + harness, implement the route, register in `server.ts`. Run the integration test → PASS. Run `pnpm --filter @garageos/api test:unit`.
- [ ] **Step 3** — Commit: `feat(api): add GET /v1/admin/me platform-admin identity route`

> **Per-task review gate:** this task is the security boundary of the whole arc (a leaky guard re-exposes cross-tenant surface in later slices). Dispatch an independent reviewer focused on: (1) negative tests truly assert 403 for BOTH other pools, (2) the conditional verifier cannot be bypassed when unconfigured, (3) no tenant claims are trusted.

---

## Task 8: `packages/admin-web` scaffold

**Files (Create — mirror `packages/web` with substitutions):**
- `packages/admin-web/package.json` — name `@garageos/admin-web`; copy scripts; trim deps to what login + one page needs (react, react-dom, react-router-dom, @tanstack/react-query, amazon-cognito-identity-js, react-hook-form, @hookform/resolvers, zod, tailwind stack, sonner, lucide-react, clsx, tailwind-merge, class-variance-authority, the Radix primitives actually used: label, slot). Dev deps identical to web.
- `vite.config.ts` — **keep `define: { global: 'globalThis' }`** (gotcha). `@` alias to `./src`.
- `tsconfig.json` / `tsconfig.app.json` / `tsconfig.node.json` — copy verbatim.
- `tailwind.config.ts`, `postcss.config.js`, `src/globals.css`, `components.json` — copy from web.
- `index.html` — title `GarageOS — Console`; keep the theme FOUC script only if you copy `ThemeContext` (optional — simplest is to drop dark mode in admin-web for Slice 0; if dropped, remove the inline script).
- `src/vite-env.d.ts` — env vars `VITE_COGNITO_PLATFORM_ADMINS_POOL_ID`, `VITE_COGNITO_PLATFORM_ADMINS_CLIENT_ID`, `VITE_API_BASE_URL`.
- `.env.example` — placeholder values for the three vars (UTF-8, no BOM).
- `.gitignore` — copy from web.
- `src/components/ui/*` + `src/lib/utils.ts` — copy ONLY the shadcn primitives the login + set-password + console screens use: `button.tsx`, `input.tsx`, `label.tsx`, `card.tsx`, `sonner.tsx` (and `utils.ts` for `cn`). Do not copy the full officine component set.

**Contract:** the app must `pnpm --filter @garageos/admin-web build` and `typecheck` clean with an empty `App` placeholder (real router in Task 10). `pnpm-workspace.yaml` already globs `packages/*` — verify, no edit expected.

**Steps:**
- [ ] **Step 1** — Create scaffold files. `pnpm install` at root (admin-web picked up by workspace). Verify single React copy: `pnpm why react --filter @garageos/admin-web` resolves to the hoisted v19.
- [ ] **Step 2** — `pnpm --filter @garageos/admin-web typecheck` + `build` green (with a trivial `App` returning a placeholder div).
- [ ] **Step 3** — Commit: `feat(admin-web): scaffold vite react app`

---

## Task 9: admin-web Cognito auth with forced password change

**Files (Create):**
- `packages/admin-web/src/lib/cognito.ts` — `platformAdminsUserPool` from the two `VITE_COGNITO_PLATFORM_ADMINS_*` env vars (mirror `web/src/lib/cognito.ts`, throwing if unset at build).
- `packages/admin-web/src/auth/AuthContext.tsx` — mirror `web/src/auth/AuthContext.tsx`, with the **new-password challenge** wired in (officine-web only shows an error here).
- `packages/admin-web/src/auth/useAuth.ts` — copy from web.
- `packages/admin-web/src/auth/ProtectedRoute.tsx` — copy from web (no role gating; any authenticated platform admin passes).
- Test: `packages/admin-web/tests/setup.ts` (mirror web, stub `VITE_COGNITO_PLATFORM_ADMINS_*`), `vitest.config.ts` (copy), `tests/auth-context.test.tsx`.

**Contract — the novel part (verbatim, since officine-web lacks it):** extend the auth state machine with a `new_password_required` status and a `completeNewPassword` action.
```ts
// AuthState gains:  | { status: 'new_password_required' }
// Keep a ref to the challenged CognitoUser + the required attributes so
// completeNewPassword can finish the challenge without re-authenticating.
const pendingUserRef = useRef<CognitoUser | null>(null);

// inside authenticateUser callbacks:
newPasswordRequired: (userAttributes) => {
  // Cognito forbids re-submitting these immutable attrs; delete them.
  delete userAttributes.email_verified;
  delete userAttributes.email;
  pendingUserRef.current = cognitoUser;
  dispatch({ type: 'NEW_PASSWORD_REQUIRED' });
  resolve();
},

const completeNewPassword = useCallback(
  (newPassword: string) =>
    new Promise<void>((resolve) => {
      const user = pendingUserRef.current;
      if (!user) { resolve(); return; }
      user.completeNewPasswordChallenge(newPassword, {}, {
        onSuccess: (session) => {
          pendingUserRef.current = null;
          dispatch({ type: 'SIGNIN_OK', user: userFromIdToken(session.getIdToken()) });
          resolve();
        },
        onFailure: (err) => {
          dispatch({ type: 'SIGNIN_ERROR', message: mapCognitoError(err) });
          resolve();
        },
      });
    }),
  [],
);
```
`userFromIdToken` for admin-web reads only `email`, `given_name`, `family_name` (no `custom:role`/`custom:tenant_id` — the pool has none). Expose `completeNewPassword` on the context value.

**Steps:**
- [ ] **Step 1** — Test (mirror `web/tests/auth-context.test.tsx`): sign-in success → `authenticated`; sign-in that triggers `newPasswordRequired` → state `new_password_required`; `completeNewPassword` success → `authenticated`. Run → FAIL.
- [ ] **Step 2** — Implement `cognito.ts` + `AuthContext.tsx` + `useAuth.ts` + `ProtectedRoute.tsx`. Run → PASS.
- [ ] **Step 3** — Commit: `feat(admin-web): cognito auth with forced password change`

---

## Task 10: admin-web pages, router, API client, landing

**Files (Create):**
- `packages/admin-web/src/lib/api-client.ts` — copy `web/src/lib/api-client.ts` verbatim (it reads `VITE_API_BASE_URL`, injects `Authorization: Bearer`, 401 → signOut).
- `packages/admin-web/src/pages/Login.tsx` — email + password form (mirror `web/src/pages/Login.tsx`). On `state.status === 'new_password_required'`, `<Navigate to="/set-password" />`.
- `packages/admin-web/src/pages/SetPassword.tsx` — single "nuova password" + "conferma" form calling `completeNewPassword`. Italian copy: title `Imposta una nuova password`, helper `Al primo accesso devi scegliere una password personale.`, submit `Salva password`.
- `packages/admin-web/src/pages/PlatformConsole.tsx` — the landing page. Calls `GET /v1/admin/me` via react-query and renders `Console piattaforma` + the signed-in admin's name/email (proves the full chain end-to-end). A `Esci` button calling `signOut`.
- `packages/admin-web/src/App.tsx` — router: public `/login`, `/set-password`; protected (`<ProtectedRoute>`) `/` → `PlatformConsole`; `*` → redirect `/`. `QueryClientProvider` + `AuthProvider` + `Toaster` like web.
- `packages/admin-web/src/main.tsx` — copy from web.
- Test: `packages/admin-web/tests/login.test.tsx` — Tier 2 (happy path renders form + submits; error state shows message; new-password state redirects). `tests/platform-console.test.tsx` — renders identity from a mocked `GET /v1/admin/me`.

**Contract:** Tier 2 UI coverage only (2-3 tests/screen, no pure-rendering assertions). All user-facing strings Italian.

**Steps:**
- [ ] **Step 1** — Tests for Login (happy/error/new-password-redirect) and PlatformConsole (renders mocked identity). Run → FAIL.
- [ ] **Step 2** — Implement pages + router + api-client. Run → PASS. `pnpm --filter @garageos/admin-web typecheck` + `build`.
- [ ] **Step 3** — Commit: `feat(admin-web): login, forced password change, console landing`

---

## Task 11: Bootstrap CLI `create-platform-admin`

**Files:**
- Create: `scripts/admin/create-platform-admin.ts`

**Contract:** operator one-shot (no tests — mirrors `scripts/rebuild-tenants.mjs` / `scripts/admin/get-invitation-link.ts`). Usage:
```
pnpm tsx scripts/admin/create-platform-admin.ts <email> <firstName> <lastName>
```
Reads pool id from `COGNITO_PLATFORM_ADMINS_POOL_ID` env (fail with exit 1 + usage if missing). `AdminCreateUserCommand` with `MessageAction: 'SUPPRESS'`, `UserAttributes` = email + email_verified=true + given_name + family_name (NO custom attrs). Generate a temporary password (reuse the 4-class generator pattern from `rebuild-tenants.mjs:46-56`) and pass it as `TemporaryPassword`; do **NOT** call `AdminSetUserPassword Permanent` — leave the user in `FORCE_CHANGE_PASSWORD`. Print to stdout: the email and the temporary password exactly once, with a one-line instruction that the admin must change it at first login on `https://admin.garageos.aifollyadvisor.com`. English comments; the printed instruction may be Italian.

**Steps:**
- [ ] **Step 1** — Implement the script.
- [ ] **Step 2** — `pnpm tsx scripts/admin/create-platform-admin.ts` with no args prints usage + exits 1 (dry verify locally without AWS creds — it should fail fast on the missing pool env BEFORE any AWS call).
- [ ] **Step 3** — Commit: `chore(admin): add create-platform-admin bootstrap cli`

---

## Task 12: CI deploy workflow + docs

**Files:**
- Create: `.github/workflows/deploy-admin-web.yml` — mirror `.github/workflows/deploy-web.yml`: build `@garageos/admin-web` with `VITE_*` admin vars from `vars.*`, sync `dist/` to the admin S3 bucket (`describe-stacks GarageosAdminWebStack` for bucket name + distribution id), CloudFront invalidation. Drop the `--` forwarding gotcha (`feedback_pnpm_dash_forwarding_ci.md`).
- Modify: `docs/APPENDICE_A_API.md` — add `GET /v1/admin/me` row (Auth: Platform Admin pool; returns admin identity).
- Modify: `docs/APPENDICE_C_INFRASTRUCTURE.md` — document the `platform-admins` pool, the `admin.` subdomain stacks, the two new secret fields, the bootstrap CLI, and the operator deploy runbook (below).
- Modify: `docs/APPENDICE_G_ERROR_CODES.md` — only if Step-1 grep found NO existing `FORBIDDEN` row covering this (it does); otherwise note "reuses FORBIDDEN" — do not invent a code.

**Operator runbook (document in APPENDICE_C, do not script):**
1. `cdk deploy GarageosMainStack` (creates the pool) → read `CognitoPlatformAdmins*` outputs.
2. `aws secretsmanager update-secret --secret-id garageos/production/app` to set the two real IDs (until then `/v1/admin/*` returns 401 — expected, Deviation 1).
3. `cdk deploy GarageosAdminWebCertStack GarageosAdminWebStack` → read admin bucket + distribution id.
4. Set GitHub repo `vars` for `deploy-admin-web.yml` (admin pool id, client id, API base url) and run the workflow (or first manual `aws s3 sync` + invalidation).
5. `pnpm tsx scripts/admin/create-platform-admin.ts <email> <first> <last>` twice (the two admins); hand each their temp password out-of-band.
6. Smoke: open `https://admin.garageos.aifollyadvisor.com`, log in, complete the forced password change, confirm `Console piattaforma` shows your identity (proves `GET /v1/admin/me`).

**Steps:**
- [ ] **Step 1** — Create the workflow; update the three docs.
- [ ] **Step 2** — `pnpm -r typecheck` green (docs/workflow don't affect it, but run the full gate).
- [ ] **Step 3** — Commit: `ci(admin-web): add deploy workflow and docs`

---

## Review gates (in order)

1. **Per-task review:** Task 7 only (security boundary) — see its gate. Tasks 1-6, 8-12 covered by the final review.
2. `pnpm -r typecheck` — pre-push hook (mandatory local gate). After Tasks 5-7 also run `pnpm --filter @garageos/api test:unit`.
3. **Final whole-branch `/code-review high`** — load-bearing. Focus: auth isolation, the conditional-verifier deploy-safety, infra count-assertion cascade, no secret/IDs committed.
4. CI full matrix (`gh pr checks --watch`) — the only gate for the infra `test:unit` (esbuild bundle, count assertions) and the API integration suite.
5. **Smoke runbook — BLOCKER** (admin-web is shell/login-facing): real-browser login + forced password change + console identity render, with the browser console open (Vite global shim gotcha). No review stage replaces this.

## Execution handoff

Large slice (12 tasks, cross-layer) → **subagent-driven** per CLAUDE.md right-sizing, with the Task 7 per-task gate and the final `/code-review high`.
