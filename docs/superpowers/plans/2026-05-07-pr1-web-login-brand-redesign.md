# PR1 — Web Login Brand Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rifare la pagina `/login` come "vetrina" brand-first dell'app GarageOS — sfondo dark navy radial gradient, logo prominente, tagline, AI Folly footer + copyright. Layout split desktop / centered mobile. Auth behavior invariato.

**Architecture:** Single-page rewrite del JSX in `packages/web/src/pages/Login.tsx`. Auth context (`useAuth`), form RHF + zod, redirect logic e validazione **non vengono toccati**. Cambia solo il markup + classi Tailwind + 2 asset PNG in `public/`. Il Login resta sempre dark indipendente dal theme — usa stili inline hard-coded che non dipendono dai shadcn tokens.

**Tech Stack:** React + Vite + Tailwind + shadcn/ui (esistente). React-hook-form + zod (esistenti). lucide-react (già nel bundle). Asset PNG statici via `public/`.

**Spec di riferimento:** `docs/superpowers/specs/2026-05-07-web-login-redesign-and-theme-system-design.md` (sezioni 3, 5, 7.1, 9 — tutte open questions resolved).

---

## File Structure

| Path | Operazione | Responsabilità |
|---|---|---|
| `packages/web/public/garageos-logo.png` | nuovo | Logo brand prodotto, kebab-case rename da `~/Downloads/garageos_logo.png` |
| `packages/web/public/aifolly-logo.png` | nuovo | Logo brand sviluppatore, kebab-case rename da `~/Downloads/aifolly_logo.png` |
| `packages/web/src/pages/Login.tsx` | rewrite del JSX | Markup + classi Tailwind + asset reference. Auth logic invariata. |
| `packages/web/tests/login.test.tsx` | +3 test | Asserzioni presenza logo GarageOS, AI Folly logo, tagline |

**Pattern di decomposizione:** un solo file di applicazione (Login.tsx) tocca markup + style. Lo spec ha già scelto di NON estrarre sotto-componenti (`LoginForm`, `LoginBranding`, `LoginFooter`) perché:
- Il file resta sotto 200 LOC
- Il Login è una pagina speciale (sempre dark, layout unico) — i sotto-componenti non sarebbero riusati altrove
- Estrazione = scope creep

Se durante l'implementazione il file supera 250 LOC, considerare estrazione `LoginBrandingPanel` (logo + tagline) e `LoginFooter` (AI Folly + copyright) come sotto-task. Soglia: 250 LOC.

---

## Pre-flight: branch + env

- [ ] **Step 0.1: Sync main + create feature branch**

```bash
git checkout main
git pull origin main
git checkout -b feat/web-login-brand-redesign
```

Expected: branch `feat/web-login-brand-redesign` checked out, main synced (HEAD `49055ae` o avanti).

- [ ] **Step 0.2: Verify dev server starts**

```bash
pnpm --filter @garageos/web dev
```

Expected: Vite serve `http://localhost:5173`. Apri in browser, verifica che lo stato attuale di `/login` sia visibile (sfondo chiaro, "GarageOS" testuale). Tieni il dev server aperto in un terminal dedicato per i prossimi step.

---

## Task 1: Copia asset logo in `public/`

**Files:**
- Create: `packages/web/public/garageos-logo.png` (binary copy + rename da `~/Downloads/garageos_logo.png`)
- Create: `packages/web/public/aifolly-logo.png` (binary copy + rename da `~/Downloads/aifolly_logo.png`)

- [ ] **Step 1.1: Copia + rename i PNG**

PowerShell:
```powershell
Copy-Item "C:\Users\Michele\Downloads\garageos_logo.png" "packages\web\public\garageos-logo.png"
Copy-Item "C:\Users\Michele\Downloads\aifolly_logo.png" "packages\web\public\aifolly-logo.png"
```

Bash equivalent:
```bash
cp "/c/Users/Michele/Downloads/garageos_logo.png" "packages/web/public/garageos-logo.png"
cp "/c/Users/Michele/Downloads/aifolly_logo.png" "packages/web/public/aifolly-logo.png"
```

Expected: `ls packages/web/public/` mostra `aifolly-logo.png`, `favicon.svg`, `garageos-logo.png` (3 file).

- [ ] **Step 1.2: Verifica che Vite serva i file in dev**

In dev server già attivo (Step 0.2), apri:
- `http://localhost:5173/garageos-logo.png` → mostra il PNG GarageOS
- `http://localhost:5173/aifolly-logo.png` → mostra il PNG AI Folly

Expected: entrambi caricano (200 OK), nessun 404.

Se 404: riavvia dev server (`Ctrl+C` + `pnpm --filter @garageos/web dev`). Vite a volte non rileva nuovi file in `public/` finché non riavviato.

- [ ] **Step 1.3: Commit asset**

```bash
git add packages/web/public/garageos-logo.png packages/web/public/aifolly-logo.png
git commit -m "feat(web): add GarageOS + AI Folly brand logos"
```

Expected: commit creato. `git log --oneline -1` mostra il commit. `git status` pulito su questi file.

---

## Task 2: Tests TDD — write failing tests prima del rewrite

**Files:**
- Modify: `packages/web/tests/login.test.tsx` — aggiungi 3 test, lascia invariati gli esistenti

- [ ] **Step 2.1: Aggiungi i 3 nuovi test al describe block**

Modifica `packages/web/tests/login.test.tsx`. Dopo l'ultimo test esistente (riga 79 `redirects to / once status flips to authenticated`), aggiungi prima della chiusura del `describe`:

```tsx
  it('renders GarageOS brand logo', () => {
    renderLogin({ status: 'unauthenticated' });
    expect(screen.getByAltText(/garageos/i)).toBeInTheDocument();
  });

  it('renders AI Folly footer logo', () => {
    renderLogin({ status: 'unauthenticated' });
    expect(screen.getByAltText(/ai folly/i)).toBeInTheDocument();
  });

  it('renders product tagline', () => {
    renderLogin({ status: 'unauthenticated' });
    expect(screen.getByText(/libretto di manutenzione/i)).toBeInTheDocument();
  });
```

Il file finale ha 10 test totali (7 esistenti + 3 nuovi).

- [ ] **Step 2.2: Run tests — verifica che i 3 nuovi falliscano**

```bash
pnpm --filter @garageos/web test -- login
```

Expected: 7 test PASS (esistenti) + 3 test FAIL (nuovi) con errore tipo:
- `TestingLibraryElementError: Unable to find an element with alt text: /garageos/i`
- `TestingLibraryElementError: Unable to find an element with alt text: /ai folly/i`
- `TestingLibraryElementError: Unable to find an element with text: /libretto di manutenzione/i`

Questo è il comportamento atteso (TDD red). Procedi.

- [ ] **Step 2.3: Commit failing tests**

```bash
git add packages/web/tests/login.test.tsx
git commit -m "test(web): add login brand assertions (logo + tagline) — TDD red"
```

Expected: commit creato. Test ancora rossi (PR è work-in-progress).

---

## Task 3: Login.tsx rewrite — mobile-first markup

**Files:**
- Modify: `packages/web/src/pages/Login.tsx` (rewrite completo del return statement, righe 47-101)

**Context per implementer:** durante questo task, **invoca il skill `frontend-design:frontend-design`** per il rewrite del JSX. Motivazione: il Login è creative work dove l'output deve evitare l'AI generic aesthetic e produrre un risultato brand-coerente. Passa a frontend-design lo spec sezione 3.3 (Visual specs) come reference.

- [ ] **Step 3.1: Sostituisci il return statement completo**

Apri `packages/web/src/pages/Login.tsx`. Sostituisci da riga 47 (`return (`) fino alla chiusura della funzione (riga 101 `}`) con:

```tsx
  return (
    <div className="min-h-screen relative bg-[radial-gradient(ellipse_at_center,#1a3358_0%,#0d1f3a_70%,#081428_100%)] flex flex-col">
      <main className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-6xl mx-auto md:grid md:grid-cols-2 md:gap-12 md:items-center">
          {/* Branding panel — top on mobile, left on desktop */}
          <div className="flex flex-col items-center md:items-start gap-4 mb-8 md:mb-0">
            <img
              src="/garageos-logo.png"
              alt="GarageOS — Digital Maintenance Logs"
              className="max-w-[200px] md:max-w-[260px] h-auto"
            />
            <p className="text-slate-300 text-base md:text-lg text-center md:text-left max-w-md">
              Il libretto di manutenzione digitale per la tua officina
            </p>
          </div>

          {/* Form panel — bottom on mobile, right on desktop */}
          <div className="w-full max-w-sm mx-auto md:max-w-md md:mx-0">
            <div className="bg-white/[0.06] backdrop-blur-md border border-white/[0.12] rounded-lg p-6 md:p-8">
              {error && (
                <Alert
                  variant="destructive"
                  className="mb-4 bg-red-950/50 border-red-700 text-red-100"
                >
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
                  <FormField
                    control={form.control}
                    name="email"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-slate-300">Email</FormLabel>
                        <FormControl>
                          <Input
                            type="email"
                            autoComplete="email"
                            placeholder="email@officina.it"
                            className="bg-white/[0.08] border-white/[0.15] text-slate-100 placeholder:text-slate-500 focus-visible:ring-[#4a90d9]/40 focus-visible:ring-2"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage className="text-red-300" />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="password"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-slate-300">Password</FormLabel>
                        <FormControl>
                          <Input
                            type="password"
                            autoComplete="current-password"
                            className="bg-white/[0.08] border-white/[0.15] text-slate-100 placeholder:text-slate-500 focus-visible:ring-[#4a90d9]/40 focus-visible:ring-2"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage className="text-red-300" />
                      </FormItem>
                    )}
                  />
                  <Button
                    type="submit"
                    disabled={submitting}
                    className="w-full bg-[#4a90d9] hover:bg-[#3a7fc9] disabled:bg-[#4a90d9]/50 text-white font-medium"
                  >
                    {submitting ? 'Accesso in corso...' : 'Accedi'}
                  </Button>
                </form>
              </Form>
            </div>
          </div>
        </div>
      </main>

      {/* Footer — AI Folly logo + copyright */}
      <footer className="py-6 px-4 flex flex-col items-center gap-2 border-t border-white/[0.05]">
        <img
          src="/aifolly-logo.png"
          alt="Powered by AI Folly"
          className="max-w-[60px] h-auto opacity-75"
        />
        <p className="text-slate-500 text-xs">
          &copy; 2026 AI Folly Srl &mdash; Tutti i diritti riservati
        </p>
      </footer>
    </div>
  );
}
```

Mantieni tutte le righe sopra il `return` (imports, `loginSchema`, `Login` function declaration, `useForm`, `useEffect`, `onSubmit`, `error`, `submitting`) **invariate**. La funzione si chiude con la `}` finale dopo il footer.

- [ ] **Step 3.2: Verifica typecheck**

```bash
pnpm --filter @garageos/web typecheck
```

Expected: zero errori. Se errore tipo "Cannot find name 'X'" → controlla che gli imports non siano cambiati e tutti i symbols (Alert, AlertDescription, Form, FormField, FormItem, FormControl, FormLabel, FormMessage, Input, Button) siano già importati nel file (lo sono dalle righe 7-18).

- [ ] **Step 3.3: Run tests — verifica che i 3 nuovi passino**

```bash
pnpm --filter @garageos/web test -- login
```

Expected: 10 test PASS totali. I 3 nuovi (logo, ai folly, tagline) ora trovano gli elementi nel DOM.

Se uno fallisce ancora:
- `getByAltText(/garageos/i)` fallisce → controlla che `alt="GarageOS — Digital Maintenance Logs"` sia presente nel logo principale
- `getByAltText(/ai folly/i)` fallisce → controlla che `alt="Powered by AI Folly"` sia presente nel footer
- `getByText(/libretto di manutenzione/i)` fallisce → controlla che la tagline sia esattamente "Il libretto di manutenzione digitale per la tua officina"

- [ ] **Step 3.4: Smoke browser — mobile**

Dev server attivo (`http://localhost:5173`). Apri DevTools, attiva mobile emulation 390×844 (iPhone 12 Pro). Vai su `/login`.

Verifica:
- ✅ Sfondo dark navy con radial gradient (più chiaro al centro, più scuro ai bordi)
- ✅ Logo GarageOS centrato in alto
- ✅ Tagline "Il libretto di manutenzione digitale..." sotto il logo, centrata
- ✅ Form glass-morphism (semi-trasparente con blur) sotto la tagline
- ✅ Logo AI Folly + copyright in footer

Se qualcosa appare rotto, fix inline e ri-run typecheck + test.

- [ ] **Step 3.5: Smoke browser — desktop**

DevTools off, finestra browser ≥1280px wide. Vai su `/login`.

Verifica:
- ✅ Layout 2-column: branding (logo + tagline) sinistra, form destra
- ✅ Tagline allineata a sinistra (`text-left` desktop)
- ✅ Logo GarageOS più grande (~260px max-width)
- ✅ Form non occupa tutto lo schermo (max-w-md mantenuto)

- [ ] **Step 3.6: Commit rewrite**

```bash
git add packages/web/src/pages/Login.tsx
git commit -m "feat(web): redesign login con dark navy + split hero layout"
```

Expected: commit creato. Test verdi locale.

---

## Task 4: Smoke completo — auth flow + edge cases

Verifica end-to-end che il behavior auth non sia rotto dal redesign visivo.

- [ ] **Step 4.1: Smoke — validazione zod**

In dev (`http://localhost:5173/login`):
1. Click "Accedi" senza compilare niente → messaggio "Inserisci un'email valida" sotto Email visibile e leggibile su dark
2. Type "not-an-email" in Email → click Accedi → stesso messaggio
3. Type email valida + password vuota → messaggio "Inserisci la password" sotto Password

Expected: tutti i messaggi sono leggibili (testo rosso `text-red-300` su sfondo glass-morphism dark).

- [ ] **Step 4.2: Smoke — error Alert**

Forza un errore Cognito: type email valida (es. `nonexistent@test.it`) + password fasulla, click Accedi.

Expected: Alert destructive appare in cima al form con sfondo `bg-red-950/50` e testo `text-red-100`. Leggibile su dark.

- [ ] **Step 4.3: Smoke — successful login**

Type email + password valida (creds Giuseppe da Bitwarden o utente seedato locale).

Expected: button mostra "Accesso in corso..." e disabled durante auth. Dopo successo, redirect a `/` (Dashboard).

- [ ] **Step 4.4: Smoke — focus state + tab order**

Su `/login` (senza credenziali): premi Tab dall'URL bar.

Expected:
1. Tab 1 → focus su input Email (ring blu visibile su dark — `ring-[#4a90d9]/40`)
2. Tab 2 → focus su input Password
3. Tab 3 → focus su button Accedi
4. Shift+Tab inverso funziona

Se il ring non è visibile → ispeziona DevTools, verifica che `focus-visible:ring-2` sia attivo. Eventualmente aumenta opacity ring (`/60` invece di `/40`).

- [ ] **Step 4.5: Build sanity**

```bash
pnpm --filter @garageos/web build
```

Expected: build completa senza errori. `dist/` generato. Verifica nei log che i 2 PNG vengano copiati in `dist/` (Vite copia tutto `public/` automaticamente).

- [ ] **Step 4.6: Esegui pre-push hook check**

```bash
pnpm -r typecheck
```

Expected: tutti i workspace verdi. Questo è ciò che girerà il husky pre-push.

---

## Task 5: Push + PR

- [ ] **Step 5.1: Push branch**

```bash
git push -u origin feat/web-login-brand-redesign
```

Expected: branch creato su remote. Husky pre-push hook esegue `pnpm -r typecheck` (verde).

- [ ] **Step 5.2: Crea PR**

```bash
gh pr create --title "feat(web): redesign login con brand identity dark navy + AI Folly footer" --body "$(cat <<'EOF'
## What

Rifatta la pagina `/login` come "vetrina" brand del prodotto in risposta al feedback Persona A "Giuseppe" (demo F-WEB-DEMO3 2026-05-06). Sfondo dark navy radial gradient, logo prominente, tagline, AI Folly footer + copyright. Layout split desktop / centered mobile.

## Why

Feedback diretto Giuseppe:
- "Sembra una pagina tecnica, non di officina"
- "Manca il logo, non si capisce subito che è GarageOS"
- "Non si legge bene"

Spec di riferimento: `docs/superpowers/specs/2026-05-07-web-login-redesign-and-theme-system-design.md` (sezione 3 — PR1).

## Implementation notes

- **Asset:** 2 PNG in `packages/web/public/` (`garageos-logo.png`, `aifolly-logo.png`). Reference via path stabile `/garageos-logo.png`.
- **Login sempre dark:** stili inline hard-coded indipendenti dai shadcn tokens. Non eredita da `.dark` class (PR2 introdurrà il theme toggle, Login esente).
- **Auth logic invariata:** form RHF + zod, `useAuth.signIn`, redirect, error Alert, submit disabled — tutto identico al PR pre-redesign.
- **Color choice:** blu `#4a90d9` come stima visuale dal logo (approvato Michele 2026-05-07, no pixel-exact match).

## Tests

- [x] 7 test esistenti behavior-focused preservati invariati
- [x] 3 nuovi test aggiunti: presenza logo GarageOS, AI Folly logo, tagline
- [x] Typecheck verde
- [x] Smoke browser eseguito mobile (390×844) + desktop (≥1280px)
- [x] Smoke auth flow: validazione, error Alert, successful login, focus/tab order
- [x] Build Vite verde, asset PNG copiati in dist/
- [x] Pre-push hook (`pnpm -r typecheck`) verde

## Out of scope

- Theme system app-wide (PR2 successiva)
- Password dimenticata / Ricordami / link supporto
- Favicon redesign

## Checklist

- [x] Code follows conventions in CONTRIBUTING.md
- [x] Types compile (`pnpm typecheck`)
- [x] Tests pass (`pnpm test` web)
- [x] No new `console.log`, no commented-out code
- [x] Secrets not committed
- [x] Spec doc committed insieme alla feature

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR creato, URL stampato. Esempio output: `https://github.com/garageos-app/garageos-app/pull/66`.

- [ ] **Step 5.3: Watch CI**

```bash
gh pr checks --watch
```

Expected: tutti i check verdi (lint, format, typecheck, test web, build, cdk-synth, ecc.).

Se rosso:
- Lint fail su `globals.css` → non applicabile in questa PR (toccata solo in PR2)
- Format fail → `pnpm exec prettier --write packages/web/src/pages/Login.tsx packages/web/tests/login.test.tsx`, commit fix
- Test fail → leggere il log CI, riprodurre locale

- [ ] **Step 5.4: Aggiungi spec doc al commit (se non già)**

Il workflow di Michele prevede che lo spec viaggi insieme alla feature PR. Verifica:

```bash
git status docs/superpowers/specs/2026-05-07-web-login-redesign-and-theme-system-design.md
```

Se mostra "untracked" o "modified", aggiungi:

```bash
git add docs/superpowers/specs/2026-05-07-web-login-redesign-and-theme-system-design.md
git commit -m "docs(web): add login redesign + theme system spec"
git push
```

Expected: spec ora parte della PR.

- [ ] **Step 5.5: Smoke prod post-merge**

Dopo squash + merge in main + auto-deploy GitHub Actions, verifica `https://app.garageos.aifollyadvisor.com/login`:

Replica gli step 3.4, 3.5, 4.1-4.4 in produzione. Aggiungi:
- ✅ Asset PNG caricano da CloudFront (no 404 in Network tab DevTools)
- ✅ Bundle hash diverso da pre-merge (cache invalidation OK)

---

## Self-review checklist

**Spec coverage** — ogni requirement della sezione 3 dello spec è coperto da un task?

| Spec section | Task |
|---|---|
| §3.1 File modificati | Task 1 (asset), Task 3 (Login.tsx), Task 2 (test) |
| §3.2 Layout responsive | Task 3 step 3.1, smoke 3.4 mobile, 3.5 desktop |
| §3.3 Visual specs | Task 3 step 3.1 (classi inline) |
| §3.4 Behavior invariato | Task 4 step 4.1-4.4 |
| §3.5 Test strategy (3 nuovi test) | Task 2 |
| §3.6 frontend-design hint | Task 3 context block |
| §7.1 Smoke runbook 8-step | Task 4 + Task 5 step 5.5 |

**Placeholder scan:** nessun TBD/TODO presente. Tutti i comandi sono completi. Tutti gli snippet di codice sono completi. ✅

**Type consistency:** `loginSchema`, `LoginValues`, `Login` (component) referenziati nello stesso modo in tutti i task. Nuovi test usano `renderLogin` helper esistente. ✅

**Granularità:** ogni step è 2-5 minuti tranne 3.1 (rewrite block ~10 minuti per via della dimensione). Accettabile come single atomic step perché sostituire il blocco è inseparabile. ✅

---

## Estimated effort

- Pre-flight + Task 1: 10 min
- Task 2 (TDD red): 10 min
- Task 3 (rewrite): 30-45 min (con frontend-design subagent)
- Task 4 (smoke): 20 min
- Task 5 (PR + CI): 15 min + CI wait

**Totale: ~90 min** (escluso CI wait + revisione human Michele).

**Stack stimato finale:** ~150-200 LOC totali (entro target 300-400 dello spec).
