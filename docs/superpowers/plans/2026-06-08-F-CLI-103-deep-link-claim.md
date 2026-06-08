# F-CLI-103 Deep-link Claim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** L'app GarageOS intercetta un deep-link `garageos://v/<code>` e atterra l'utente sul form di claim veicolo pre-compilato con il codice, pronto per la conferma.

**Architecture:** Route redirector file-based `app/v/[code].tsx` (idiomatica expo-router) che valida il codice via `extractGarageCode` e, in base allo stato auth, ridirige a `/claim-vehicle?code=…` (loggato) o `/login?claimCode=…` (sloggato, con post-login deferred). Il form claim guadagna una prop `initialCode`. Zero backend/migration/deploy/dep.

**Tech Stack:** React Native + Expo (SDK 52) + expo-router 4 + TypeScript. Test: jest-expo + @testing-library/react-native.

---

## File Structure

- **Modify** `packages/mobile/src/components/ClaimVehicleForm.tsx` — nuova prop `initialCode?: string` che inizializza lo state `code`.
- **Modify** `packages/mobile/app/claim-vehicle.tsx` — legge `?code` (`useLocalSearchParams`), valida, passa `initialCode` al form.
- **Create** `packages/mobile/app/v/[code].tsx` — redirector auth-aware (nessuna UI oltre lo spinner).
- **Modify** `packages/mobile/app/login.tsx` — legge `params.claimCode`; al login riuscito ridirige al claim se presente.
- **Modify** `packages/mobile/tests/components/ClaimVehicleForm.test.tsx` — pre-fill.
- **Create** `packages/mobile/tests/screens/claim-vehicle.test.tsx` — passaggio param→form.
- **Create** `packages/mobile/tests/screens/v-code.test.tsx` — redirector (4 casi).
- **Modify** `packages/mobile/tests/screens/login.test.tsx` — deferred claimCode.

**Convenzioni note (dal checkpoint):**
- I run jest mobile vanno in background: redirige l'output a file controllato + loop `grep __EXIT`. Esempio: `pnpm --filter @garageos/mobile test -- <pattern> > /tmp/jest.out 2>&1; echo "__EXIT $?__" >> /tmp/jest.out` e poi leggi `/tmp/jest.out`.
- Dopo aver creato la NUOVA route `app/v/[code].tsx`, esegui `rm -f packages/mobile/.expo/types/router.d.ts` (lo stale locale fa fallire tsc; CI non ce l'ha).
- Commit message via file: `printf '...' > /tmp/cm.txt && git commit -F /tmp/cm.txt`. Scope in enum (`mobile`), header ≤72, body ≤100.

---

## Task 1: `ClaimVehicleForm` — prop `initialCode`

**Files:**
- Modify: `packages/mobile/src/components/ClaimVehicleForm.tsx`
- Test: `packages/mobile/tests/components/ClaimVehicleForm.test.tsx`

- [ ] **Step 1: Write the failing tests**

Aggiungi in fondo al `describe('ClaimVehicleForm', …)` di `tests/components/ClaimVehicleForm.test.tsx` (importa `waitFor` è già importato):

```tsx
it('pre-fills the code field from initialCode', () => {
  render(<ClaimVehicleForm onSubmit={jest.fn()} onCancel={jest.fn()} initialCode="GO-482-KXRT" />);
  expect(screen.getByDisplayValue('GO-482-KXRT')).toBeOnTheScreen();
});

it('submits the pre-filled initialCode when "Aggiungi" is tapped', async () => {
  const onSubmit = jest.fn().mockResolvedValue({ ok: true });
  render(
    <ClaimVehicleForm onSubmit={onSubmit} onCancel={jest.fn()} initialCode="GO-482-KXRT" />,
  );
  fireEvent.press(screen.getByRole('button', { name: 'Aggiungi' }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('GO-482-KXRT'));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @garageos/mobile test -- ClaimVehicleForm > /tmp/jest.out 2>&1; echo "__EXIT $?__" >> /tmp/jest.out`
Then read `/tmp/jest.out`.
Expected: FAIL — `initialCode` non è una prop nota (TS) / il campo è vuoto (`Unable to find an element with displayValue: GO-482-KXRT`).

- [ ] **Step 3: Add the prop**

In `src/components/ClaimVehicleForm.tsx`, estendi il type `Props` e inizializza lo state:

```tsx
type Props = {
  onSubmit: (garageCode: string) => Promise<ClaimVehicleFormResult>;
  onCancel: () => void;
  initialCode?: string;
};

export function ClaimVehicleForm({ onSubmit, onCancel, initialCode }: Props) {
  const [code, setCode] = useState(initialCode ?? '');
  // …resto invariato
```

(Unica modifica: la firma di `Props`, la destrutturazione, e `useState('')` → `useState(initialCode ?? '')`.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @garageos/mobile test -- ClaimVehicleForm > /tmp/jest.out 2>&1; echo "__EXIT $?__" >> /tmp/jest.out`
Then read `/tmp/jest.out`.
Expected: PASS — tutti i test del file verdi (i preesistenti + i 2 nuovi).

- [ ] **Step 5: Commit**

```bash
printf 'feat(mobile): add initialCode prop to ClaimVehicleForm\n' > /tmp/cm.txt
git add packages/mobile/src/components/ClaimVehicleForm.tsx packages/mobile/tests/components/ClaimVehicleForm.test.tsx
git commit -F /tmp/cm.txt
```

---

## Task 2: `claim-vehicle.tsx` — legge il param `?code`

**Files:**
- Modify: `packages/mobile/app/claim-vehicle.tsx`
- Create: `packages/mobile/tests/screens/claim-vehicle.test.tsx`

- [ ] **Step 1: Write the failing test**

Crea `tests/screens/claim-vehicle.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react-native';
import ClaimVehicleScreen from '../../app/claim-vehicle';
import { useLocalSearchParams } from 'expo-router';

jest.mock('@/queries/claimVehicle', () => ({
  useClaimVehicle: () => ({ mutateAsync: jest.fn() }),
}));
jest.mock('expo-router', () => ({
  useRouter: jest.fn(() => ({ replace: jest.fn(), back: jest.fn() })),
  useLocalSearchParams: jest.fn(),
  Stack: { Screen: () => null },
}));
// Stub the form: render the received initialCode so the test can assert it.
jest.mock('@/components/ClaimVehicleForm', () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const React = require('react');
  const { Text } = require('react-native');
  /* eslint-enable @typescript-eslint/no-require-imports */
  return {
    ClaimVehicleForm: ({ initialCode }: { initialCode?: string }) =>
      React.createElement(Text, null, `INITIAL:${initialCode ?? 'none'}`),
  };
});

const mockedParams = useLocalSearchParams as jest.Mock;

describe('ClaimVehicle screen', () => {
  beforeEach(() => jest.clearAllMocks());

  it('passes a valid ?code to the form as initialCode', () => {
    mockedParams.mockReturnValue({ code: 'GO-482-KXRT' });
    render(<ClaimVehicleScreen />);
    expect(screen.getByText('INITIAL:GO-482-KXRT')).toBeOnTheScreen();
  });

  it('ignores a malformed ?code (form gets no initialCode)', () => {
    mockedParams.mockReturnValue({ code: 'junk' });
    render(<ClaimVehicleScreen />);
    expect(screen.getByText('INITIAL:none')).toBeOnTheScreen();
  });

  it('handles an absent ?code (form gets no initialCode)', () => {
    mockedParams.mockReturnValue({});
    render(<ClaimVehicleScreen />);
    expect(screen.getByText('INITIAL:none')).toBeOnTheScreen();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @garageos/mobile test -- claim-vehicle > /tmp/jest.out 2>&1; echo "__EXIT $?__" >> /tmp/jest.out`
Then read `/tmp/jest.out`.
Expected: FAIL — la prima asserzione trova `INITIAL:none` invece di `INITIAL:GO-482-KXRT` (lo screen non legge ancora il param).

- [ ] **Step 3: Read and validate the param**

In `app/claim-vehicle.tsx`, importa `useLocalSearchParams` e la regex, e deriva `initialCode`:

```tsx
import { ScrollView, StyleSheet } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { ClaimVehicleForm, type ClaimVehicleFormResult } from '@/components/ClaimVehicleForm';
import { useClaimVehicle } from '@/queries/claimVehicle';
import { GARAGE_CODE_RE } from '@/lib/validators/claimVehicle';
import { ApiError } from '@/lib/api-error';
import { colors } from '@/theme/colors';

export default function ClaimVehicleScreen() {
  const router = useRouter();
  const mutation = useClaimVehicle();
  // A deep-link (app/v/[code].tsx) or post-login redirect lands here with the
  // GarageOS code in ?code. Pre-fill only a well-formed code (BR-020); the form
  // and server re-validate regardless.
  const { code } = useLocalSearchParams<{ code?: string }>();
  const normalized = code?.trim().toUpperCase();
  const initialCode = normalized && GARAGE_CODE_RE.test(normalized) ? normalized : undefined;

  async function onSubmit(garageCode: string): Promise<ClaimVehicleFormResult> {
    try {
      const res = await mutation.mutateAsync({ garageCode });
      router.replace(`/(tabs)/vehicles/${res.vehicle.id}`);
      return { ok: true };
    } catch (e) {
      if (e instanceof ApiError) return { ok: false, code: e.code };
      return { ok: false, code: 'unknown' };
    }
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: 'Aggiungi veicolo' }} />
      <ScrollView style={styles.container} keyboardShouldPersistTaps="handled">
        <ClaimVehicleForm
          onSubmit={onSubmit}
          onCancel={() => router.back()}
          initialCode={initialCode}
        />
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @garageos/mobile test -- claim-vehicle > /tmp/jest.out 2>&1; echo "__EXIT $?__" >> /tmp/jest.out`
Then read `/tmp/jest.out`.
Expected: PASS — 3 test verdi.

- [ ] **Step 5: Commit**

```bash
printf 'feat(mobile): pre-fill claim form from ?code param\n' > /tmp/cm.txt
git add packages/mobile/app/claim-vehicle.tsx packages/mobile/tests/screens/claim-vehicle.test.tsx
git commit -F /tmp/cm.txt
```

---

## Task 3: `app/v/[code].tsx` — redirector deep-link

**Files:**
- Create: `packages/mobile/app/v/[code].tsx`
- Create: `packages/mobile/tests/screens/v-code.test.tsx`

- [ ] **Step 1: Write the failing test**

Crea `tests/screens/v-code.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react-native';
import VCodeScreen from '../../app/v/[code]';
import { useAuth } from '@/auth/useAuth';
import { useLocalSearchParams } from 'expo-router';

jest.mock('@/auth/useAuth', () => ({ useAuth: jest.fn() }));
jest.mock('expo-router', () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const React = require('react');
  const { Text } = require('react-native');
  /* eslint-enable @typescript-eslint/no-require-imports */
  return {
    useLocalSearchParams: jest.fn(),
    Redirect: ({ href }: { href: string }) => React.createElement(Text, null, `REDIRECT:${href}`),
  };
});

const mockedAuth = useAuth as jest.Mock;
const mockedParams = useLocalSearchParams as jest.Mock;

describe('Deep-link /v/[code] redirector', () => {
  beforeEach(() => jest.clearAllMocks());

  it('authenticated + valid code → redirects to claim with the code', () => {
    mockedAuth.mockReturnValue({ status: 'authenticated' });
    mockedParams.mockReturnValue({ code: 'GO-482-KXRT' });
    render(<VCodeScreen />);
    expect(screen.getByText('REDIRECT:/claim-vehicle?code=GO-482-KXRT')).toBeOnTheScreen();
  });

  it('unauthenticated + valid code → redirects to login carrying the code', () => {
    mockedAuth.mockReturnValue({ status: 'unauthenticated' });
    mockedParams.mockReturnValue({ code: 'GO-482-KXRT' });
    render(<VCodeScreen />);
    expect(screen.getByText('REDIRECT:/login?claimCode=GO-482-KXRT')).toBeOnTheScreen();
  });

  it('authenticated + malformed code → redirects to claim without a code', () => {
    mockedAuth.mockReturnValue({ status: 'authenticated' });
    mockedParams.mockReturnValue({ code: 'junk' });
    render(<VCodeScreen />);
    expect(screen.getByText('REDIRECT:/claim-vehicle')).toBeOnTheScreen();
  });

  it('unauthenticated + malformed code → redirects to plain login', () => {
    mockedAuth.mockReturnValue({ status: 'unauthenticated' });
    mockedParams.mockReturnValue({ code: 'junk' });
    render(<VCodeScreen />);
    expect(screen.getByText('REDIRECT:/login')).toBeOnTheScreen();
  });

  it('auth loading → shows a fullscreen loader, no redirect', () => {
    mockedAuth.mockReturnValue({ status: 'loading' });
    mockedParams.mockReturnValue({ code: 'GO-482-KXRT' });
    render(<VCodeScreen />);
    expect(screen.getByLabelText('Caricamento')).toBeOnTheScreen();
    expect(screen.queryByText(/^REDIRECT:/)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @garageos/mobile test -- v-code > /tmp/jest.out 2>&1; echo "__EXIT $?__" >> /tmp/jest.out`
Then read `/tmp/jest.out`.
Expected: FAIL — modulo `app/v/[code]` inesistente (`Cannot find module`).

- [ ] **Step 3: Create the redirector**

Crea `app/v/[code].tsx`:

```tsx
import { Redirect, useLocalSearchParams } from 'expo-router';
import { useAuth } from '@/auth/useAuth';
import { extractGarageCode } from '@/lib/qr';
import { LoadingState } from '@/components/LoadingState';

// Deep-link target for the invite/QR URL .../v/<code> (Specifiche §4.5). The
// canonical link is garageos://v/<code> (custom scheme, Expo Go) and, once a dev
// build ships universal links, https://app.garageos.it/v/<code> — both map here.
// This route only routes: it validates the code (BR-020) and hands off to the
// claim form. The server stays authoritative (POST /me/vehicles/claim).
export default function DeepLinkClaimScreen() {
  const { status } = useAuth();
  const { code } = useLocalSearchParams<{ code?: string }>();
  const valid = extractGarageCode(code ?? '');

  if (status === 'loading') return <LoadingState variant="fullscreen" />;

  if (status === 'unauthenticated') {
    // Defer: carry the code through login so a registered user lands on the
    // pre-filled claim form after signing in (login.tsx honors ?claimCode).
    return <Redirect href={valid ? `/login?claimCode=${valid}` : '/login'} />;
  }

  return <Redirect href={valid ? `/claim-vehicle?code=${valid}` : '/claim-vehicle'} />;
}
```

- [ ] **Step 4: Drop the stale typed-routes file**

Run: `rm -f packages/mobile/.expo/types/router.d.ts`
(La nuova route rende stale il file generato; CI non ce l'ha. Verrà rigenerato al prossimo `expo start`.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @garageos/mobile test -- v-code > /tmp/jest.out 2>&1; echo "__EXIT $?__" >> /tmp/jest.out`
Then read `/tmp/jest.out`.
Expected: PASS — 5 test verdi.

- [ ] **Step 6: Commit**

```bash
printf 'feat(mobile): add /v/[code] deep-link claim redirector\n' > /tmp/cm.txt
git add packages/mobile/app/v/[code].tsx packages/mobile/tests/screens/v-code.test.tsx
git commit -F /tmp/cm.txt
```

---

## Task 4: `login.tsx` — post-login deferred claim

**Files:**
- Modify: `packages/mobile/app/login.tsx`
- Modify: `packages/mobile/tests/screens/login.test.tsx`

- [ ] **Step 1: Write the failing test**

Aggiungi in `tests/screens/login.test.tsx`, dentro `describe('Login screen', …)`:

```tsx
it('redirects to the pre-filled claim when ?claimCode is present on success', async () => {
  const replace = jest.fn();
  mockedRouter.mockReturnValue({ replace, push: jest.fn() });
  mockedParams.mockReturnValue({ claimCode: 'GO-482-KXRT' });
  mockedCognito.signInSrp.mockResolvedValue({
    idToken: 'id',
    accessToken: 'access',
    refreshToken: 'refresh',
    customerId: 'cust',
    email: 'u@example.com',
  });
  await renderLogin();
  fireEvent.changeText(screen.getByPlaceholderText('Email'), 'u@example.com');
  fireEvent.changeText(screen.getByPlaceholderText('Password'), 'pwd123abc');
  fireEvent.press(screen.getByRole('button', { name: 'Accedi' }));
  await waitFor(() =>
    expect(replace).toHaveBeenCalledWith('/claim-vehicle?code=GO-482-KXRT'),
  );
});
```

(Il test esistente `'calls signIn and redirects on success'` — senza `claimCode` — continua ad attendersi `'/(tabs)'`, verificando il ramo di default.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @garageos/mobile test -- screens/login > /tmp/jest.out 2>&1; echo "__EXIT $?__" >> /tmp/jest.out`
Then read `/tmp/jest.out`.
Expected: FAIL — `replace` chiamato con `'/(tabs)'` invece di `'/claim-vehicle?code=GO-482-KXRT'`.

- [ ] **Step 3: Honor the claimCode param**

In `app/login.tsx`: estendi il tipo dei params e ramifica la redirect post-login.

Cambia la riga dei params:

```tsx
const params = useLocalSearchParams<{ reset?: string; claimCode?: string }>();
```

E nel `handleSubmit`, sostituisci `router.replace('/(tabs)');` con:

```tsx
      await signIn(email.trim(), password);
      // A deep-link claim deferred through login (app/v/[code].tsx) carries the
      // code in ?claimCode; land the user on the pre-filled claim form.
      router.replace(params.claimCode ? `/claim-vehicle?code=${params.claimCode}` : '/(tabs)');
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @garageos/mobile test -- screens/login > /tmp/jest.out 2>&1; echo "__EXIT $?__" >> /tmp/jest.out`
Then read `/tmp/jest.out`.
Expected: PASS — tutti i test del file verdi (i preesistenti, incluso il ramo `'/(tabs)'`, + il nuovo).

- [ ] **Step 5: Commit**

```bash
printf 'feat(mobile): land on pre-filled claim after deferred login\n' > /tmp/cm.txt
git add packages/mobile/app/login.tsx packages/mobile/tests/screens/login.test.tsx
git commit -F /tmp/cm.txt
```

---

## Task 5: Full verification

**Files:** none (gate)

- [ ] **Step 1: Run the full mobile suite**

Run: `pnpm --filter @garageos/mobile test > /tmp/jest.out 2>&1; echo "__EXIT $?__" >> /tmp/jest.out`
Then read `/tmp/jest.out`.
Expected: PASS — tutte le suite verdi (le 42 preesistenti + 1 nuova file `v-code` + 1 nuova `claim-vehicle`).

- [ ] **Step 2: Repo-wide typecheck**

Run: `pnpm -r typecheck > /tmp/tsc.out 2>&1; echo "__EXIT $?__" >> /tmp/tsc.out`
Then read `/tmp/tsc.out`.
Expected: PASS — nessun errore. (Se compare un errore su `.expo/types/router.d.ts`, ri-esegui `rm -f packages/mobile/.expo/types/router.d.ts` e ripeti.)

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feat/cli-103-deep-link-claim
```

Apri la PR con `gh pr create`. Descrizione: cita F-CLI-103 (Specifiche §3.3.2/§4.4/§4.5); segnala le **deviazioni doc differite** (universal-link nativi https + landing "app non installata" + signup-con-codice). Checklist: typecheck ✅, suite mobile ✅, smoke device 🟡 post-merge non bloccante.

---

## Smoke device (post-merge, non bloccante)

Con Metro attivo (`pnpm --filter @garageos/mobile start`) + `adb reverse tcp:8081`:

```bash
adb shell am start -W -a android.intent.action.VIEW -d "exp://localhost:8081/--/v/GO-482-KXRT"
```

Verifica: loggato → claim pre-compilato → "Aggiungi" → dettaglio veicolo; sloggato → login → post-accesso claim pre-compilato; codice malformato (`-d ".../--/v/junk"`) → form vuoto. (Usa un codice di un veicolo reale in prod, es. il Fiat Tipo `GO-973-JJHM` lasciato dai test, per arrivare fino al dettaglio.)
