# Spec — Web Login Redesign + Theme System

**Date:** 2026-05-07
**Author:** Michele Matula (brainstorming session) + Claude Opus 4.7
**Status:** Draft, pending user approval
**Decomposition:** 2 PR sequenziali

---

## 1. Context & motivation

Durante la demo Persona A "Giuseppe" (2026-05-06) il pilot operatore ha shippato il flusso F-WEB-DEMO3 8/8 PASS in produzione (vedi memoria `project_resume_checkpoint`). Il feedback raccolto direttamente da Giuseppe è stato concentrato sulla schermata di Login:

- "Sembra una pagina tecnica, non di officina" — manca contesto/calore visivo
- "Manca il logo, non si capisce subito che è GarageOS"
- "Non si legge bene" — leggibilità tipografica/contrasto migliorabile

Le altre 3 schermate (Search per targa, Scheda veicolo/Timeline, Form crea intervento) sono state validate senza richieste di modifica. Lo scope di questo spec è quindi **solo la prima impressione brand** + un'infrastruttura theme che permetta agli operatori di lavorare comodamente in dark mode anche post-login.

Non c'è BR (`docs/APPENDICE_F_BUSINESS_LOGIC.md`) coinvolto — questo è un cambio di design, non di business logic.

## 2. Solution overview

Decomposizione in **2 PR sequenziali**:

- **PR1 — Login redesign brand-first** (~300-400 LOC). La pagina `/login` viene rifatta come "vetrina" del prodotto: sfondo dark navy radial gradient (matching del logo GarageOS), layout split desktop / centered mobile, logo GarageOS prominente con tagline, logo AI Folly + copyright in footer. **Sempre dark, indipendente dal toggle utente.**

- **PR2 — Theme system app-wide** (~600-900 LOC). ThemeProvider React + persistenza in `localStorage`, default `light`. Toggle icon (Sun/Moon) nella TopBar dell'app post-login. Variants Tailwind `dark:` applicate a tutte le pagine app (Dashboard, SearchResults, VehicleDetail, InterventionCreate) e ai componenti layout (AppLayout, Sidebar, TopBar).

**Decisioni architetturali concordate:**
- Login = pagina marketing/vetrina, sempre dark navy radial. NON segue il toggle utente.
- App = work-tool, default light, toggle utente disponibile.
- I 2 dark sono **diversi di proposito**: Login = navy radial immersivo (brand), app = slate flat shadcn (sobrio per work).
- Pattern di riferimento: Notion, Linear, Stripe (welcome immersivo, app sobria).

## 3. PR1 — Login redesign dettaglio

### 3.1 File modificati/aggiunti

| File | Operazione | LOC stimato |
|---|---|---|
| `packages/web/public/garageos-logo.png` | nuovo (rename da `~/Downloads/garageos_logo.png`, kebab-case) | binary |
| `packages/web/public/aifolly-logo.png` | nuovo (rename da `~/Downloads/aifolly_logo.png`, kebab-case) | binary |
| `packages/web/src/pages/Login.tsx` | rewrite del JSX (auth logic invariata) | ~140 (era ~100) |
| `packages/web/tests/login.test.tsx` | +3 test (logo + tagline) | +20 |

### 3.2 Layout responsive

Mobile (`<md`, `<768px`):
- Single column
- Ordine verticale: Logo (top) → Tagline → Form card → Footer AI Folly + copyright (bottom)
- `max-w-sm` (384px) centered

Desktop (`md+`, `≥768px`):
- Grid `2-column 1fr/1fr`, gap `gap-12`
- Sinistra: Logo + Tagline centered verticalmente
- Destra: Form card (glass-morphism)
- Footer AI Folly + copyright sticky bottom, full-width

### 3.3 Visual specs

**Background:** `min-h-screen bg-[radial-gradient(ellipse_at_center,#1a3358_0%,#0d1f3a_70%,#081428_100%)]`

**Form card (glass-morphism):**
- `bg-white/6 backdrop-blur-md border border-white/12 rounded-lg`
- Padding `p-6` su mobile, `p-8` desktop

**Tipografia & colori (dentro la card):**
- Label: `text-slate-300 text-sm`
- Input text: `text-slate-100 placeholder:text-slate-500`
- Input bg: `bg-white/8 border-white/15 focus:ring-[#4a90d9]/40`
- Submit button: `bg-[#4a90d9] hover:bg-[#3a7fc9] text-white` (colore preciso campionato dal PNG durante implementazione — vedi Open Q3)
- Submit disabled: `bg-[#4a90d9]/50`
- Alert error: `bg-red-950/50 border-red-700 text-red-100`

**Logo dimensioni:**
- GarageOS logo: `max-w-[200px] md:max-w-[260px]` (alt: "GarageOS — Digital Maintenance Logs")
- AI Folly logo: `max-w-[60px] opacity-75` (alt: "Powered by AI Folly")

**Tagline:** `text-slate-300 text-base md:text-lg text-center md:text-left`
> "Il libretto di manutenzione digitale per la tua officina"

**Footer copyright:** `text-slate-500 text-xs`
> "© 2026 AI Folly Srl — Tutti i diritti riservati"

### 3.4 Behavior (invariato)

- Form RHF + zod (`loginSchema`: email + password min 1 char)
- `onSubmit` chiama `signIn(email, password)` (Cognito via `useAuth`)
- Redirect `/` quando `state.status === 'authenticated'`
- Submit disabled durante `state.status === 'authenticating'` con label "Accesso in corso..."
- Alert destructive su `state.error`
- Validation messaggi italiani invariati

### 3.5 Test strategy PR1

Esistenti (preservati invariati):
- `renders email + password fields and a submit button`
- `shows zod validation error when email is empty`
- `shows validation error when email is malformed`
- `calls signIn with email + password on valid submit`
- `renders the destructive Alert with the auth error message`
- `disables submit and shows pending text while authenticating`
- `redirects to / once status flips to authenticated`

Nuovi (3 test):
- `renders GarageOS brand logo` — `getByAltText(/garageos/i)` in document
- `renders AI Folly footer logo` — `getByAltText(/ai folly/i)` in document
- `renders product tagline` — `getByText(/libretto di manutenzione/i)` in document

### 3.6 Implementation hint per subagent

Durante l'implementazione, il subagent **deve** invocare il skill `frontend-design:frontend-design` per il rewrite del JSX. Motivazione: il Login è creative/visual work dove l'output deve evitare la "AI generic aesthetic" e produrre un risultato brand-coerente.

## 4. PR2 — Theme system dettaglio

### 4.1 File modificati/aggiunti

| File | Operazione | LOC stimato |
|---|---|---|
| `packages/web/src/theme/ThemeContext.tsx` | nuovo (Provider + Context) | ~60 |
| `packages/web/src/theme/useTheme.ts` | nuovo (hook export) | ~10 |
| `packages/web/src/theme/ThemeToggle.tsx` | nuovo (Sun/Moon icon button) | ~30 |
| `packages/web/index.html` | script inline anti-FOUC pre-React-mount | +10 |
| `packages/web/src/App.tsx` | wrappa AuthProvider in ThemeProvider | +3 |
| `packages/web/src/components/layout/TopBar.tsx` | aggiunge `<ThemeToggle />` in alto a destra | +5 |
| `packages/web/src/globals.css` | aggiunge `.dark { ... }` block con shadcn dark tokens | +25 |
| `packages/web/tailwind.config.ts` | nessuna modifica — `darkMode: ['class']` già attivo (verificato) | 0 |
| `packages/web/src/pages/Login.tsx` | nessuna modifica logica — verifica che il radial gradient hard-coded non venga mai sovrascritto da `.dark` | 0 |
| `packages/web/src/components/layout/AppLayout.tsx` | `bg-slate-50` → `bg-background` (token-based) | +1 |
| `packages/web/src/components/layout/Sidebar.tsx` | dark variants su classi hard-coded | +20 |
| `packages/web/src/components/layout/TopBar.tsx` | dark variants su classi hard-coded | +10 |
| `packages/web/src/pages/Dashboard.tsx` | dark variants | +30 |
| `packages/web/src/pages/SearchResults.tsx` | dark variants | +50 |
| `packages/web/src/pages/VehicleDetail.tsx` | dark variants | +80 |
| `packages/web/src/pages/InterventionCreate.tsx` | dark variants | +60 |
| Altri component custom in `components/` | dark variants come emergono | +50 |
| `packages/web/tests/theme-context.test.tsx` | nuovo | +60 |
| `packages/web/tests/theme-toggle.test.tsx` | nuovo | +40 |

### 4.2 ThemeProvider design

```tsx
type Theme = 'light' | 'dark';

type ThemeContextValue = {
  theme: Theme;
  setTheme: (next: Theme) => void;
  toggleTheme: () => void;
};
```

- Storage key: `garageos-theme`
- Default: `'light'` (se `localStorage` vuoto o invalid)
- Effetto: applica/rimuove la classe `dark` su `document.documentElement` quando `theme` cambia

### 4.3 Anti-FOUC script (in `index.html`)

Script blocking inline prima del bundle React:

```html
<script>
  (function () {
    try {
      var t = localStorage.getItem('garageos-theme');
      if (t === 'dark') document.documentElement.classList.add('dark');
    } catch (e) {}
  })();
</script>
```

Lettura sincrona prima del first paint → no flash. Il provider React legge poi lo stesso storage e si allinea.

### 4.4 Login esente dal toggle

Il route `/login` usa il radial gradient inline (`bg-[radial-gradient(...)]`) come root container con `relative` positioning. Anche se `<html>` ha la classe `dark`, il container Login override visivamente. Verifica esplicita nello smoke runbook: "logout → resta dark navy indipendente dal toggle precedente".

### 4.5 ThemeToggle component

Posizione: TopBar, allineato a destra accanto al menu utente.
Icon: `lucide-react` `Sun` (light mode → click per andare a dark) / `Moon` (dark mode → click per andare a light).
A11y: `aria-label="Cambia tema chiaro/scuro"` con `aria-pressed` riflesso.
Click handler: `toggleTheme()`.

### 4.6 globals.css dark tokens

Aggiunta del block `.dark` con tokens shadcn standard slate:

```css
.dark {
  --background: 222.2 84% 4.9%;
  --foreground: 210 40% 98%;
  --card: 222.2 84% 4.9%;
  --card-foreground: 210 40% 98%;
  --popover: 222.2 84% 4.9%;
  --popover-foreground: 210 40% 98%;
  --primary: 210 40% 98%;
  --primary-foreground: 222.2 47.4% 11.2%;
  --secondary: 217.2 32.6% 17.5%;
  --secondary-foreground: 210 40% 98%;
  --muted: 217.2 32.6% 17.5%;
  --muted-foreground: 215 20.2% 65.1%;
  --accent: 217.2 32.6% 17.5%;
  --accent-foreground: 210 40% 98%;
  --destructive: 0 62.8% 30.6%;
  --destructive-foreground: 210 40% 98%;
  --border: 217.2 32.6% 17.5%;
  --input: 217.2 32.6% 17.5%;
  --ring: 212.7 26.8% 83.9%;
}
```

### 4.7 Test strategy PR2

Unit `theme-context.test.tsx`:
- `default theme is light` — `<html>` non ha classe `dark` quando provider monta senza `localStorage`
- `applies dark class when theme is dark` — set theme=dark → `document.documentElement.classList.contains('dark')`
- `toggleTheme flips light → dark → light`
- `persists theme in localStorage on change` — `localStorage.getItem('garageos-theme')` aggiornato

Unit `theme-toggle.test.tsx`:
- `renders Sun icon when theme is light` (verify by `getByLabelText('Cambia tema chiaro/scuro')` + svg name)
- `renders Moon icon when theme is dark`
- `click toggles theme` — invoca `toggleTheme` mockato e ricalcola icon

Esistenti (Dashboard, InterventionCreate, Sidebar test): verifico che eventuali asserzioni hard-coded su classi tipo `bg-slate-50` vengano aggiornate a `bg-background`. Behavior preservato.

## 5. Asset pipeline

- Location: `packages/web/public/` (no Vite import, URL stabile `/garageos-logo.png` e `/aifolly-logo.png`)
- Naming: kebab-case (rename da snake_case dei file Downloads)
- Servizio: in dev via Vite dev server, in prod via CloudFront (le custom path sotto `/` sono già route-handled correttamente)
- Trade-off vs `src/assets/`: si rinuncia all'hashing per cache busting, accettabile per asset di brand stabili

**Favicon:** `packages/web/public/favicon.svg` attuale resta. Sostituirlo con un favicon derivato dal logo GarageOS è **out of scope**. Aggiunto a `project_tech_debt.md` come Minor.

**AI Folly visibility:** solo Login footer. App post-login non mostra AI Folly branding.

## 6. Test verification gates (entrambi PR)

Pre-push (locale, husky pre-push hook):
- `pnpm -r typecheck` (~30s, mandatorio)

Post-push (CI GitHub Actions):
- lint + format:check
- `pnpm --filter @garageos/web test` (vitest)
- `pnpm --filter @garageos/web build` (Vite build, sanity)
- cdk-synth (non rilevante per queste PR)

Per ogni PR, prima di marcare "complete" (skill `verification-before-completion`):
- ✅ `pnpm typecheck` verde — output esplicito
- ✅ `pnpm test` verde con count test passati — output esplicito
- ✅ Smoke runbook eseguito step-by-step — log/screenshot
- ✅ `gh pr checks --watch` verde post-push

## 7. Smoke runbook

### 7.1 PR1 — F-LOGIN-REDESIGN (8 step)

Eseguire in dev (`pnpm --filter @garageos/web dev`, port 5173) **e** in prod post-deploy.

1. Apri `/login` su Chrome desktop ≥1280px → layout 2-column: logo+tagline left, form right
2. Apri `/login` su mobile (DevTools 390×844 emulation) → layout single-column centered
3. Verifica radial gradient navy visibile (ispeziona el `body`/root container, no flash bianco al load)
4. Tab order: Email → Password → Submit; focus ring blu visibile su dark
5. Submit con email vuota → messaggio italiano "Inserisci un'email valida" leggibile su dark
6. Submit con credenziali errate → Alert destructive con contrasto sufficiente (verifica con axe DevTools opzionale)
7. Submit valido (creds Giuseppe demo da Bitwarden) → redirect `/`
8. Footer: logo AI Folly visibile + copyright "© 2026 AI Folly Srl..." leggibile

### 7.2 PR2 — F-THEME-TOGGLE (8 step)

1. Login con creds → atterro su Dashboard, **light mode** (default)
2. ThemeToggle (Sun icon) visibile in TopBar; click → app passa a dark, icon flippa a Moon
3. F5 reload → ancora dark (persistenza localStorage)
4. DevTools Console: `localStorage.removeItem('garageos-theme')` + reload → torna light (default reset)
5. Naviga in tutte le 4 pagine app (Dashboard, /search, /vehicles/:id, intervention create) in entrambi mode → no contrasto rotto, no testo invisibile, no shadow nero su nero, no input non leggibile
6. Logout → atterro su `/login` → **sempre dark navy radial**, indipendente dal toggle precedente
7. Login di nuovo → theme app preservato (dark se era dark al logout)
8. Hard refresh `/login` con DevTools throttle Slow 3G → no FOUC visible (no flash di tema sbagliato durante il load)

## 8. Out of scope (explicit)

- ❌ "Password dimenticata" / "Ricordami" / link supporto
- ❌ Onboarding/welcome screen post-login
- ❌ Refactor componenti shadcn (già coprono dark via tokens)
- ❌ Favicon redesign (favicon.svg attuale resta)
- ❌ Mobile native app theming
- ❌ Logo upload/swap multi-tenant white-label
- ❌ Dark theme per Login (Login hard-coded dark, non modificabile)
- ❌ Theme toggle nella Sidebar (solo TopBar)
- ❌ Animation/transition theme switch (applicazione istantanea)
- ❌ Reduced-motion preferences
- ❌ Accessibility audit completo WCAG AA (ci si limita a verifica manuale durante smoke)

## 9. Resolved decisions (was: Open questions)

1. **Logo licensing — APPROVATO 2026-05-07:** `garageos-logo.png` e `aifolly-logo.png` autorizzati al commit nel repo public. Vanno in `packages/web/public/` come asset committed.

2. **Tagline — CONFERMATA 2026-05-07:** "Il libretto di manutenzione digitale per la tua officina" è il wording finale, hard-coded in `Login.tsx`.

3. **Button color — APPROVATA STIMA VISUALE 2026-05-07:** `#4a90d9` accettato come valore di brand. Niente campionamento pixel-exact dal PNG. Se durante smoke browser appare visivamente off rispetto al logo, raffinare in PR di follow-up.

## 10. Risk assessment

| Rischio | PR | Severity | Mitigazione |
|---|---|---|---|
| FOUC su page load (flash di tema sbagliato) | PR2 | Medium | Script inline blocking pre-React-mount in `index.html` |
| Regressione contrasto in dark mode (testo illeggibile) | PR2 | Medium | Smoke runbook su tutte e 4 le pagine in entrambi mode prima merge |
| `bg-slate-50` hard-coded sparso nei test rompe assertion | PR2 | Low | Grep tests pre-implementazione, aggiornare a `bg-background` |
| Path `public/` errato in build (PNG 404) | PR1 | Low | `pnpm --filter @garageos/web build` + verify in dev sul dist serve |
| Test esistenti login.test.tsx breakano per cambio markup | PR1 | Very Low | Test sono behavior-focused (`getByLabelText`, `getByRole`) — preservati |
| Lint-staged glob non copre `globals.css` | PR2 | Low | Pattern già noto (memoria `feedback_lintstaged_html_gap`); workaround `pnpm exec prettier --write packages/web/src/globals.css` pre-commit |
| Drift dark tokens vs custom components | PR2 | Low | Plan obbliga a iterazione visual su ogni page in dark mode prima di marcare done |

## 11. Branch & commit conventions

- Branch PR1: `feat/web-login-brand-redesign`
- Branch PR2: `feat/web-theme-system-dark-mode`
- Commit convention: Conventional Commits, scope `web`
- Esempi:
  - `feat(web): redesign login con brand identity dark navy + AI Folly footer`
  - `feat(web): theme system dark/light con toggle utente`
  - `feat(web): apply dark variants a Dashboard/Search/VehicleDetail`
  - `test(web): add theme-context + theme-toggle unit tests`

## 12. Memorie correlate

- `project_resume_checkpoint.md` — feedback Giuseppe e contesto demo
- `feedback_lintstaged_html_gap.md` — gotcha CSS file format pre-commit
- `feedback_actions_quota_public_flip.md` — repo pubblico, attenzione asset committed
- `project_tech_debt.md` — voci da aggiungere (favicon redesign Minor)

## 13. Next step

Dopo approval di questo spec:
- Invocare `superpowers:writing-plans` per produrre l'implementation plan dettagliato (1 plan unitario o 2 plan separati per PR1 / PR2 — la scelta è del writing-plans skill).
- Plan-side la sequenza dei task per ogni PR è già abbozzata nelle sezioni 3-4 di questo spec.
